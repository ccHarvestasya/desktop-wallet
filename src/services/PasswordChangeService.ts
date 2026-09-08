/*
 * (C) Symbol Contributors 2021
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

import { Crypto, Password } from 'symbol-sdk';
import { AccountModel } from '@/core/database/entities/AccountModel';
import { HarvestingModel } from '@/core/database/entities/HarvestingModel';
import { ProfileModel } from '@/core/database/entities/ProfileModel';
import { IStorage } from '@/core/database/backends/IStorage';
import { ProfileModelStorage } from '@/core/database/storage/ProfileModelStorage';
import { AccountModelStorage } from '@/core/database/storage/AccountModelStorage';
import { HarvestingModelStorage } from '@/core/database/storage/HarvestingModelStorage';
import { SimpleObjectStorage } from '@/core/database/backends/SimpleObjectStorage';
import { AccountService } from './AccountService';
import { ProfileService } from './ProfileService';

type Profiles = Record<string, ProfileModel>;
type Accounts = Record<string, AccountModel>;
type HarvestingPrivateKeyField = 'encRemotePrivateKey' | 'newEncRemotePrivateKey' | 'encVrfPrivateKey' | 'newEncVrfPrivateKey';
type StorageVersion = number | null;

interface PasswordChangeStorageVersions {
    profiles: StorageVersion;
    accounts: StorageVersion;
    harvestingModels: StorageVersion;
}

export interface PasswordChangeSnapshot {
    version: number;
    storageVersions: PasswordChangeStorageVersions;
    profiles: Profiles | null;
    accounts: Accounts | null;
    harvestingModels: HarvestingModel[] | null;
}

const HARVESTING_PRIVATE_KEY_FIELDS: HarvestingPrivateKeyField[] = [
    'encRemotePrivateKey',
    'newEncRemotePrivateKey',
    'encVrfPrivateKey',
    'newEncVrfPrivateKey',
];

/**
 * Re-encrypts all password-protected data belonging to a profile.
 *
 * Preparation is intentionally separate from persistence. The three storage
 * collections are only written after every selected value has been processed.
 */
export class PasswordChangeService {
    private readonly accountService: AccountService;

    public constructor(
        private readonly profilesStorage: IStorage<Profiles> = ProfileModelStorage.INSTANCE,
        private readonly accountsStorage: IStorage<Accounts> = AccountModelStorage.INSTANCE,
        private readonly harvestingStorage: IStorage<HarvestingModel[]> = HarvestingModelStorage.INSTANCE,
        accountService: AccountService = new AccountService(),
        private readonly snapshotStorage: IStorage<PasswordChangeSnapshot> = new SimpleObjectStorage<PasswordChangeSnapshot>(
            'passwordChangeSnapshot',
        ),
    ) {
        this.accountService = accountService;
    }

    /**
     * Restores a password change left incomplete by an interrupted process.
     */
    public static recover(): void {
        new PasswordChangeService().recoverPendingChange();
    }

    public recoverPendingChange(): void {
        const snapshot = this.snapshotStorage.get();
        if (snapshot === undefined) {
            return;
        }
        if (!this.isValidSnapshot(snapshot)) {
            throw new Error('An incomplete password change snapshot was rejected.');
        }

        const restoreErrors = [
            this.restoreSnapshot(this.profilesStorage, snapshot.profiles === null ? undefined : snapshot.profiles),
            this.restoreSnapshot(this.accountsStorage, snapshot.accounts === null ? undefined : snapshot.accounts),
            this.restoreSnapshot(this.harvestingStorage, snapshot.harvestingModels === null ? undefined : snapshot.harvestingModels),
        ].filter((restoreError) => restoreError !== undefined);
        if (restoreErrors.length > 0) {
            throw new Error('An incomplete password change could not be restored.');
        }

        try {
            this.snapshotStorage.remove();
            if (this.snapshotStorage.get() !== undefined) {
                throw new Error('Password change snapshot could not be removed.');
            }
        } catch (_) {
            throw new Error('An incomplete password change could not be finalized.');
        }
    }

    /**
     * Changes a profile password and atomically updates all related encrypted
     * values from the point of view of the application storage.
     */
    public changePassword(profile: ProfileModel, oldPassword: Password, newPassword: Password, passwordHint: string): void {
        this.recoverPendingChange();

        const profilesSnapshot = this.clone(this.profilesStorage.get());
        const accountsSnapshot = this.clone(this.accountsStorage.get());
        const harvestingSnapshot = this.clone(this.harvestingStorage.get());

        const updatedProfiles = this.clone(profilesSnapshot) || {};
        const updatedAccounts = this.clone(accountsSnapshot) || {};
        const updatedHarvestingModels = this.clone(harvestingSnapshot) || [];
        const currentProfile = (profilesSnapshot && profilesSnapshot[profile.profileName]) || profile;

        const updatedProfile = {
            ...(updatedProfiles[profile.profileName] || currentProfile),
            password: ProfileService.getPasswordHash(newPassword),
            hint: passwordHint,
            seed: this.reencryptValue(currentProfile.seed, oldPassword, newPassword),
        } as ProfileModel;
        updatedProfiles[profile.profileName] = updatedProfile;

        const accountAddresses = new Set<string>();
        (currentProfile.accounts || []).forEach((accountId) => {
            const account = updatedAccounts[accountId];
            if (!account) {
                throw new Error('Cannot change the password because a referenced account is missing.');
            }
            if (account.profileName !== currentProfile.profileName) {
                throw new Error('Cannot change the password because a referenced account belongs to another profile.');
            }

            const updatedAccount = this.accountService.updateWalletPassword(account, oldPassword, newPassword);
            const updatedRemoteAccountPrivateKey = this.reencryptValue(account.encRemoteAccountPrivateKey, oldPassword, newPassword);
            updatedAccounts[accountId] =
                updatedRemoteAccountPrivateKey === undefined && account.encRemoteAccountPrivateKey === undefined
                    ? updatedAccount
                    : ({ ...updatedAccount, encRemoteAccountPrivateKey: updatedRemoteAccountPrivateKey } as AccountModel);
            accountAddresses.add(account.address);
        });

        this.ensureHarvestingAccountsAreNotShared(currentProfile, profilesSnapshot, accountsSnapshot, accountAddresses);

        const reencryptedHarvestingModels = updatedHarvestingModels.map((harvestingModel) => {
            if (!accountAddresses.has(harvestingModel.accountAddress)) {
                return harvestingModel;
            }

            return this.reencryptHarvestingModel(harvestingModel, oldPassword, newPassword);
        });
        const shouldSaveAccounts = accountsSnapshot !== undefined && (currentProfile.accounts || []).length > 0;
        const shouldSaveHarvesting = harvestingSnapshot !== undefined && !this.areEqual(reencryptedHarvestingModels, harvestingSnapshot);
        const snapshot: PasswordChangeSnapshot = {
            version: 1,
            storageVersions: {
                profiles: this.getStorageVersion(this.profilesStorage),
                accounts: this.getStorageVersion(this.accountsStorage),
                harvestingModels: this.getStorageVersion(this.harvestingStorage),
            },
            profiles: profilesSnapshot === undefined ? null : profilesSnapshot,
            accounts: accountsSnapshot === undefined ? null : accountsSnapshot,
            harvestingModels: harvestingSnapshot === undefined ? null : harvestingSnapshot,
        };

        // The snapshot only contains the existing encrypted representations and is kept
        // until all collection writes and read-back checks have completed.
        this.persistSnapshot(snapshot);

        try {
            this.profilesStorage.set(updatedProfiles);
            if (shouldSaveAccounts) {
                this.accountsStorage.set(updatedAccounts);
            }
            if (shouldSaveHarvesting) {
                this.harvestingStorage.set(reencryptedHarvestingModels);
            }
            this.verifySavedValue(this.profilesStorage, updatedProfiles);
            if (shouldSaveAccounts) {
                this.verifySavedValue(this.accountsStorage, updatedAccounts);
            }
            if (shouldSaveHarvesting) {
                this.verifySavedValue(this.harvestingStorage, reencryptedHarvestingModels);
            }
            this.snapshotStorage.remove();
            if (this.snapshotStorage.get() !== undefined) {
                throw new Error('Password change snapshot could not be removed.');
            }
        } catch (error) {
            const rollbackErrors = [
                this.restoreSnapshot(this.profilesStorage, profilesSnapshot),
                this.restoreSnapshot(this.accountsStorage, accountsSnapshot),
                this.restoreSnapshot(this.harvestingStorage, harvestingSnapshot),
            ].filter((rollbackError) => rollbackError !== undefined);
            if (rollbackErrors.length > 0) {
                throw new Error('Password change failed and the previous data could not be restored.');
            }
            try {
                this.snapshotStorage.remove();
            } catch (_) {
                // Keep the snapshot for recovery on the next application start.
            }
            throw error;
        }
    }

    private ensureHarvestingAccountsAreNotShared(
        profile: ProfileModel,
        profilesSnapshot: Profiles | undefined,
        accountsSnapshot: Accounts | undefined,
        accountAddresses: Set<string>,
    ): void {
        const profiles = profilesSnapshot || {};
        const accounts = accountsSnapshot || {};
        const hasSharedAccount = Object.keys(profiles).some((profileName) => {
            if (profileName === profile.profileName) {
                return false;
            }

            const otherProfile = profiles[profileName];
            return (otherProfile.accounts || []).some((accountId) => {
                const account = accounts[accountId];
                return account !== undefined && accountAddresses.has(account.address);
            });
        });

        if (hasSharedAccount) {
            throw new Error('Cannot change the password because a harvesting account is shared by multiple profiles.');
        }
    }

    private reencryptHarvestingModel(model: HarvestingModel, oldPassword: Password, newPassword: Password): HarvestingModel {
        const updatedModel = { ...model };
        HARVESTING_PRIVATE_KEY_FIELDS.forEach((field) => {
            const encryptedValue = model[field] as string | null | undefined;
            if (encryptedValue === '' || encryptedValue === null || encryptedValue === undefined) {
                return;
            }

            updatedModel[field] = this.reencryptValue(encryptedValue, oldPassword, newPassword) as never;
        });
        return updatedModel;
    }

    private reencryptValue(value: string | null | undefined, oldPassword: Password, newPassword: Password): string | null | undefined {
        if (value === '' || value === null || value === undefined) {
            return value;
        }

        // P0 preserves the SDK's existing decrypt return values and errors.
        return Crypto.encrypt(Crypto.decrypt(value, oldPassword.value), newPassword.value);
    }

    private restoreSnapshot<E>(storage: IStorage<E>, snapshot: E | undefined): Error | undefined {
        try {
            if (snapshot === undefined) {
                storage.remove();
            } else {
                storage.set(this.clone(snapshot));
            }
            if (!this.areEqual(storage.get(), snapshot)) {
                return new Error('Snapshot verification failed.');
            }
            return undefined;
        } catch (_) {
            return new Error('Snapshot restoration failed.');
        }
    }

    private verifySavedValue<E>(storage: IStorage<E>, expected: E): void {
        if (!this.areEqual(storage.get(), expected)) {
            throw new Error('Password change persistence verification failed.');
        }
    }

    private persistSnapshot(snapshot: PasswordChangeSnapshot): void {
        try {
            this.snapshotStorage.set(this.clone(snapshot));
            this.verifySavedValue(this.snapshotStorage, snapshot);
        } catch (error) {
            let storedSnapshot: PasswordChangeSnapshot | undefined;
            try {
                storedSnapshot = this.snapshotStorage.get();
            } catch (_) {
                // A malformed read-back is handled by the cleanup attempt below.
            }

            if (storedSnapshot !== undefined && this.isValidSnapshot(storedSnapshot) && this.areEqual(storedSnapshot, snapshot)) {
                // Keep a complete journal when the storage reported a failure after writing it.
                throw error;
            }

            try {
                this.snapshotStorage.remove();
                if (this.snapshotStorage.get() !== undefined) {
                    throw new Error('Password change snapshot could not be removed.');
                }
            } catch (_) {
                try {
                    // If cleanup failed after a partial write, replace it with a complete
                    // journal so the next startup can still restore the old collections.
                    this.snapshotStorage.set(this.clone(snapshot));
                    this.verifySavedValue(this.snapshotStorage, snapshot);
                } catch (_) {
                    throw new Error('Password change could not create a recoverable snapshot.');
                }
            }
            throw error;
        }
    }

    private isValidSnapshot(snapshot: PasswordChangeSnapshot): boolean {
        return (
            this.isRecord(snapshot) &&
            this.hasOwnProperties(snapshot, ['version', 'storageVersions', 'profiles', 'accounts', 'harvestingModels']) &&
            snapshot.version === 1 &&
            this.isValidStorageVersions(snapshot.storageVersions) &&
            this.isValidProfiles(snapshot.profiles) &&
            this.isValidAccounts(snapshot.accounts) &&
            this.isValidHarvestingModels(snapshot.harvestingModels) &&
            this.areProfileAccountReferencesValid(snapshot.profiles, snapshot.accounts) &&
            this.areStorageVersionsCompatible(snapshot.storageVersions)
        );
    }

    private isValidProfiles(profiles: Profiles | null): boolean {
        return (
            profiles === null ||
            (this.isRecord(profiles) &&
                Object.entries(profiles).every(
                    ([profileName, profile]) => this.isValidProfile(profile) && profileName === profile.profileName,
                ))
        );
    }

    private isValidAccounts(accounts: Accounts | null): boolean {
        return (
            accounts === null ||
            (this.isRecord(accounts) &&
                Object.entries(accounts).every(([accountId, account]) => this.isValidAccount(account) && accountId === account.id))
        );
    }

    private isValidHarvestingModels(harvestingModels: HarvestingModel[] | null): boolean {
        return (
            harvestingModels === null ||
            (Array.isArray(harvestingModels) && harvestingModels.every((harvestingModel) => this.isValidHarvestingModel(harvestingModel)))
        );
    }

    private isValidHarvestingModel(harvestingModel: HarvestingModel): boolean {
        return (
            this.isRecord(harvestingModel) &&
            typeof harvestingModel.accountAddress === 'string' &&
            this.isOptionalEncryptedValue(harvestingModel.encRemotePrivateKey) &&
            this.isOptionalEncryptedValue(harvestingModel.newEncRemotePrivateKey) &&
            this.isOptionalEncryptedValue(harvestingModel.encVrfPrivateKey) &&
            this.isOptionalEncryptedValue(harvestingModel.newEncVrfPrivateKey) &&
            this.isOptionalString(harvestingModel.newRemotePublicKey) &&
            this.isOptionalString(harvestingModel.newVrfPublicKey) &&
            this.isOptionalBoolean(harvestingModel.isPersistentDelReqSent) &&
            this.isOptionalBoolean(harvestingModel.delegatedHarvestingRequestFailed) &&
            this.isOptionalNode(harvestingModel.selectedHarvestingNode) &&
            this.isOptionalNode(harvestingModel.newSelectedHarvestingNode)
        );
    }

    private isValidProfile(profile: ProfileModel): boolean {
        return (
            this.isRecord(profile) &&
            typeof profile.profileName === 'string' &&
            typeof profile.generationHash === 'string' &&
            typeof profile.hint === 'string' &&
            typeof profile.networkType === 'number' &&
            typeof profile.password === 'string' &&
            typeof profile.seed === 'string' &&
            Array.isArray(profile.accounts) &&
            profile.accounts.every((accountId) => typeof accountId === 'string') &&
            typeof profile.termsAndConditionsApproved === 'boolean' &&
            typeof profile.selectedNodeUrlToConnect === 'string'
        );
    }

    private isValidAccount(account: AccountModel): boolean {
        return (
            this.isRecord(account) &&
            typeof account.id === 'string' &&
            typeof account.name === 'string' &&
            typeof account.profileName === 'string' &&
            typeof account.node === 'string' &&
            typeof account.type === 'number' &&
            typeof account.address === 'string' &&
            typeof account.publicKey === 'string' &&
            typeof account.encryptedPrivateKey === 'string' &&
            typeof account.path === 'string' &&
            typeof account.isMultisig === 'boolean' &&
            (account.encRemoteAccountPrivateKey === undefined || typeof account.encRemoteAccountPrivateKey === 'string')
        );
    }

    private isValidStorageVersions(storageVersions: PasswordChangeStorageVersions): boolean {
        return (
            this.isRecord(storageVersions) &&
            this.hasOwnProperties(storageVersions, ['profiles', 'accounts', 'harvestingModels']) &&
            [storageVersions.profiles, storageVersions.accounts, storageVersions.harvestingModels].every(
                (version) => version === null || (typeof version === 'number' && Number.isInteger(version) && version > 0),
            )
        );
    }

    private areProfileAccountReferencesValid(profiles: Profiles | null, accounts: Accounts | null): boolean {
        if (profiles === null) {
            return true;
        }
        if (accounts === null) {
            return Object.values(profiles).every((profile) => profile.accounts.length === 0);
        }
        return Object.values(profiles).every((profile) =>
            profile.accounts.every(
                (accountId) => accounts[accountId] !== undefined && accounts[accountId].profileName === profile.profileName,
            ),
        );
    }

    private isOptionalEncryptedValue(value: string | null | undefined): boolean {
        return value === null || value === undefined || typeof value === 'string';
    }

    private isOptionalString(value: string | null | undefined): boolean {
        return value === null || value === undefined || typeof value === 'string';
    }

    private isOptionalBoolean(value: boolean | undefined): boolean {
        return value === undefined || typeof value === 'boolean';
    }

    private isOptionalNode(node: HarvestingModel['selectedHarvestingNode']): boolean {
        return (
            node === undefined ||
            (this.isRecord(node) &&
                typeof node.url === 'string' &&
                typeof node.friendlyName === 'string' &&
                typeof node.isDefault === 'boolean' &&
                typeof node.networkType === 'number' &&
                this.isOptionalString(node.publicKey) &&
                this.isOptionalString(node.nodePublicKey) &&
                this.isOptionalString(node.wsUrl))
        );
    }

    private areStorageVersionsCompatible(storageVersions: PasswordChangeStorageVersions): boolean {
        return (
            this.isStorageVersionCompatible(this.profilesStorage, storageVersions.profiles) &&
            this.isStorageVersionCompatible(this.accountsStorage, storageVersions.accounts) &&
            this.isStorageVersionCompatible(this.harvestingStorage, storageVersions.harvestingModels)
        );
    }

    private isStorageVersionCompatible<E>(storage: IStorage<E>, snapshotVersion: StorageVersion): boolean {
        // A missing collection is restored by removing any partial collection, regardless
        // of the current version wrapper that may have been created after the crash.
        if (snapshotVersion === null) {
            return true;
        }
        return this.getStorageVersion(storage) === snapshotVersion;
    }

    private getStorageVersion<E>(storage: IStorage<E>): StorageVersion {
        const versionedStorage = storage as IStorage<E> & { getVersion?: () => unknown };
        const version = versionedStorage.getVersion ? versionedStorage.getVersion() : undefined;
        return typeof version === 'number' ? version : null;
    }

    private isRecord(value: any): value is Record<string, any> {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    private hasOwnProperties(value: Record<string, any>, properties: string[]): boolean {
        return properties.every((property) => Object.prototype.hasOwnProperty.call(value, property));
    }

    private areEqual<E>(left: E | undefined, right: E | undefined): boolean {
        return JSON.stringify(left) === JSON.stringify(right);
    }

    private clone<E>(value: E): E {
        if (value === undefined || value === null) {
            return value;
        }
        if (Array.isArray(value)) {
            return (value.map((item) => this.clone(item)) as unknown) as E;
        }
        if (typeof value === 'object') {
            const cloned: Record<string, unknown> = {};
            Object.keys(value as Record<string, unknown>).forEach((key) => {
                cloned[key] = this.clone((value as Record<string, unknown>)[key]);
            });
            return cloned as E;
        }
        return value;
    }
}
