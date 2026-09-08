/** @jest-environment node */

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

import { Crypto, NetworkType, Password } from 'symbol-sdk';
import { AccountModel } from '@/core/database/entities/AccountModel';
import { HarvestingModel } from '@/core/database/entities/HarvestingModel';
import { ProfileModel } from '@/core/database/entities/ProfileModel';
import { IStorage } from '@/core/database/backends/IStorage';
import { PasswordChangeService, PasswordChangeSnapshot } from '@/services/PasswordChangeService';
import { ProfileService } from '@/services/ProfileService';
import { account1Params, WalletsModel1, WalletsModel2 } from '@MOCKS/Accounts';

class MemoryStorage<E> implements IStorage<E> {
    public setCalls = 0;
    public failNextSet = false;
    public ignoreNextSet = false;

    public constructor(private value: E | undefined) {}

    public get(): E | undefined {
        return this.value;
    }

    public set(value: E): void {
        this.setCalls++;
        if (this.failNextSet) {
            this.failNextSet = false;
            throw new Error('storage failure');
        }
        if (this.ignoreNextSet) {
            this.ignoreNextSet = false;
            return;
        }
        this.value = value;
    }

    public remove(): void {
        this.value = undefined;
    }
}

const oldPassword = account1Params.password;
const newPassword = new Password('Password2');

const encrypt = (value: string): string => Crypto.encrypt(value, oldPassword.value);

const createProfile = (accounts: string[]): ProfileModel =>
    ({
        profileName: 'profile1',
        generationHash: '',
        hint: 'old hint',
        networkType: NetworkType.TEST_NET,
        password: '',
        seed: encrypt('profile seed'),
        accounts,
        termsAndConditionsApproved: true,
        selectedNodeUrlToConnect: '',
    } as ProfileModel);

interface Fixture {
    profilesStorage: MemoryStorage<Record<string, ProfileModel>>;
    accountsStorage: MemoryStorage<Record<string, AccountModel>>;
    harvestingStorage: MemoryStorage<HarvestingModel[]>;
    snapshotStorage: MemoryStorage<PasswordChangeSnapshot>;
    profile: ProfileModel;
}

const createFixture = (): Fixture => {
    const profile = createProfile([WalletsModel1.id, WalletsModel2.id]);
    const harvestingModels: HarvestingModel[] = [
        {
            accountAddress: WalletsModel1.address,
            encRemotePrivateKey: encrypt('remote private key'),
            newEncRemotePrivateKey: encrypt('new remote private key'),
            encVrfPrivateKey: encrypt('vrf private key'),
            newEncVrfPrivateKey: encrypt('new vrf private key'),
        },
        {
            accountAddress: 'UNRELATED-ACCOUNT',
            encRemotePrivateKey: 'unchanged remote ciphertext',
        },
    ];
    const profilesStorage = new MemoryStorage({ profile1: profile });
    const accountsStorage = new MemoryStorage({
        [WalletsModel1.id]: { ...WalletsModel1, encRemoteAccountPrivateKey: encrypt('remote account private key') },
        [WalletsModel2.id]: { ...WalletsModel2 },
    });
    const harvestingStorage = new MemoryStorage(harvestingModels);
    const snapshotStorage = new MemoryStorage<PasswordChangeSnapshot>(undefined);

    return { profilesStorage, accountsStorage, harvestingStorage, snapshotStorage, profile };
};

const createService = (fixture: Fixture): PasswordChangeService =>
    new PasswordChangeService(
        fixture.profilesStorage,
        fixture.accountsStorage,
        fixture.harvestingStorage,
        undefined,
        fixture.snapshotStorage,
    );

describe('services/PasswordChangeService', () => {
    it('re-encrypts the profile seed, account keys, and all four harvesting key fields', () => {
        const fixture = createFixture();

        createService(fixture).changePassword(fixture.profile, oldPassword, newPassword, 'new hint');

        const updatedProfile = fixture.profilesStorage.get().profile1;
        expect(Crypto.decrypt(updatedProfile.seed, newPassword.value)).toBe('profile seed');
        expect(updatedProfile.password).toBe(ProfileService.getPasswordHash(newPassword));
        expect(updatedProfile.hint).toBe('new hint');

        const updatedAccounts = fixture.accountsStorage.get();
        expect(Crypto.decrypt(updatedAccounts[WalletsModel1.id].encryptedPrivateKey, newPassword.value)).toBe(account1Params.privateKey);
        expect(Crypto.decrypt(updatedAccounts[WalletsModel1.id].encRemoteAccountPrivateKey, newPassword.value)).toBe(
            'remote account private key',
        );
        expect(Crypto.decrypt(updatedAccounts[WalletsModel2.id].encryptedPrivateKey, newPassword.value)).toBe(
            Crypto.decrypt(WalletsModel2.encryptedPrivateKey, oldPassword.value),
        );

        const updatedHarvestingModel = fixture.harvestingStorage.get()[0];
        expect(Crypto.decrypt(updatedHarvestingModel.encRemotePrivateKey, newPassword.value)).toBe('remote private key');
        expect(Crypto.decrypt(updatedHarvestingModel.newEncRemotePrivateKey, newPassword.value)).toBe('new remote private key');
        expect(Crypto.decrypt(updatedHarvestingModel.encVrfPrivateKey, newPassword.value)).toBe('vrf private key');
        expect(Crypto.decrypt(updatedHarvestingModel.newEncVrfPrivateKey, newPassword.value)).toBe('new vrf private key');
        expect(fixture.harvestingStorage.get()[1].encRemotePrivateKey).toBe('unchanged remote ciphertext');
        expect(fixture.profilesStorage.setCalls).toBe(1);
        expect(fixture.accountsStorage.setCalls).toBe(1);
        expect(fixture.harvestingStorage.setCalls).toBe(1);
        expect(fixture.snapshotStorage.get()).toBeUndefined();
    });

    it('preserves empty and undefined harvesting key fields', () => {
        const fixture = createFixture();
        const model = fixture.harvestingStorage.get()[0];
        (model as any).encRemotePrivateKey = '';
        (model as any).newEncRemotePrivateKey = undefined;
        (model as any).encVrfPrivateKey = null;

        createService(fixture).changePassword(fixture.profile, oldPassword, newPassword, 'new hint');

        const updatedModel = fixture.harvestingStorage.get()[0];
        expect(updatedModel.encRemotePrivateKey).toBe('');
        expect(updatedModel.newEncRemotePrivateKey).toBeUndefined();
        expect(updatedModel.encVrfPrivateKey).toBeNull();
        expect(Crypto.decrypt(updatedModel.newEncVrfPrivateKey, newPassword.value)).toBe('new vrf private key');
    });

    it('does not persist when a referenced account is missing', () => {
        const fixture = createFixture();
        delete fixture.accountsStorage.get()[WalletsModel2.id];

        expect(() => createService(fixture).changePassword(fixture.profile, oldPassword, newPassword, 'new hint')).toThrow(
            'referenced account is missing',
        );
        expect(fixture.profilesStorage.setCalls).toBe(0);
        expect(fixture.accountsStorage.setCalls).toBe(0);
        expect(fixture.harvestingStorage.setCalls).toBe(0);
    });

    it('does not persist when a referenced account belongs to another profile', () => {
        const fixture = createFixture();
        (fixture.accountsStorage.get()[WalletsModel2.id] as any).profileName = 'profile2';

        expect(() => createService(fixture).changePassword(fixture.profile, oldPassword, newPassword, 'new hint')).toThrow(
            'belongs to another profile',
        );
        expect(fixture.profilesStorage.setCalls).toBe(0);
        expect(fixture.accountsStorage.setCalls).toBe(0);
        expect(fixture.harvestingStorage.setCalls).toBe(0);
    });

    it('does not persist when an account is shared by another profile', () => {
        const fixture = createFixture();
        fixture.profilesStorage.get().profile2 = {
            ...fixture.profile,
            profileName: 'profile2',
            accounts: [WalletsModel1.id],
        };

        expect(() => createService(fixture).changePassword(fixture.profile, oldPassword, newPassword, 'new hint')).toThrow(
            'shared by multiple profiles',
        );
        expect(fixture.profilesStorage.setCalls).toBe(0);
        expect(fixture.accountsStorage.setCalls).toBe(0);
        expect(fixture.harvestingStorage.setCalls).toBe(0);
    });

    it.each(['profiles', 'accounts', 'harvestingModels'])('restores all collections when %s persistence fails', (failedCollection) => {
        const fixture = createFixture();
        const originalProfiles = fixture.profilesStorage.get();
        const originalAccounts = fixture.accountsStorage.get();
        const originalHarvestingModels = fixture.harvestingStorage.get();
        if (failedCollection === 'profiles') {
            fixture.profilesStorage.failNextSet = true;
        } else if (failedCollection === 'accounts') {
            fixture.accountsStorage.failNextSet = true;
        } else {
            fixture.harvestingStorage.failNextSet = true;
        }

        let error: Error;
        try {
            createService(fixture).changePassword(fixture.profile, oldPassword, newPassword, 'new hint');
        } catch (caughtError) {
            error = caughtError;
        }

        expect(error).toEqual(new Error('storage failure'));
        expect(fixture.profilesStorage.get()).toEqual(originalProfiles);
        expect(fixture.accountsStorage.get()).toEqual(originalAccounts);
        expect(fixture.harvestingStorage.get()).toEqual(originalHarvestingModels);
        expect(fixture.snapshotStorage.get()).toBeUndefined();
    });

    it('restores a pending snapshot before the next password change attempt', () => {
        const fixture = createFixture();
        const snapshot: PasswordChangeSnapshot = {
            version: 1,
            storageVersions: {
                profiles: null,
                accounts: null,
                harvestingModels: null,
            },
            profiles: fixture.profilesStorage.get(),
            accounts: fixture.accountsStorage.get(),
            harvestingModels: fixture.harvestingStorage.get(),
        };
        fixture.snapshotStorage.set(snapshot);
        fixture.profilesStorage.set({ changed: fixture.profile } as any);
        fixture.accountsStorage.set({});
        fixture.harvestingStorage.set([]);

        createService(fixture).recoverPendingChange();

        expect(fixture.profilesStorage.get()).toEqual(snapshot.profiles);
        expect(fixture.accountsStorage.get()).toEqual(snapshot.accounts);
        expect(fixture.harvestingStorage.get()).toEqual(snapshot.harvestingModels);
        expect(fixture.snapshotStorage.get()).toBeUndefined();
    });

    it('rejects an incomplete recovery snapshot without changing stored collections', () => {
        const fixture = createFixture();
        const originalProfiles = fixture.profilesStorage.get();
        const originalAccounts = fixture.accountsStorage.get();
        const originalHarvestingModels = fixture.harvestingStorage.get();
        fixture.snapshotStorage.set({ version: 1 } as any);

        expect(() => createService(fixture).recoverPendingChange()).toThrow('incomplete password change snapshot');
        expect(fixture.profilesStorage.get()).toEqual(originalProfiles);
        expect(fixture.accountsStorage.get()).toEqual(originalAccounts);
        expect(fixture.harvestingStorage.get()).toEqual(originalHarvestingModels);
    });

    it.each([null, false])('rejects a malformed recovery snapshot (%p) without changing stored collections', (snapshot) => {
        const fixture = createFixture();
        const originalProfiles = fixture.profilesStorage.get();
        const originalAccounts = fixture.accountsStorage.get();
        const originalHarvestingModels = fixture.harvestingStorage.get();
        fixture.snapshotStorage.set(snapshot as any);

        expect(() => createService(fixture).recoverPendingChange()).toThrow('incomplete password change snapshot');
        expect(fixture.profilesStorage.get()).toEqual(originalProfiles);
        expect(fixture.accountsStorage.get()).toEqual(originalAccounts);
        expect(fixture.harvestingStorage.get()).toEqual(originalHarvestingModels);
    });

    it('does not persist when the snapshot cannot be read back', () => {
        const fixture = createFixture();
        fixture.snapshotStorage.ignoreNextSet = true;

        expect(() => createService(fixture).changePassword(fixture.profile, oldPassword, newPassword, 'new hint')).toThrow(
            'persistence verification failed',
        );
        expect(fixture.profilesStorage.setCalls).toBe(0);
        expect(fixture.accountsStorage.setCalls).toBe(0);
        expect(fixture.harvestingStorage.setCalls).toBe(0);
    });

    it('does not persist when the snapshot write fails', () => {
        const fixture = createFixture();
        fixture.snapshotStorage.failNextSet = true;

        expect(() => createService(fixture).changePassword(fixture.profile, oldPassword, newPassword, 'new hint')).toThrow(
            'storage failure',
        );
        expect(fixture.profilesStorage.setCalls).toBe(0);
        expect(fixture.accountsStorage.setCalls).toBe(0);
        expect(fixture.harvestingStorage.setCalls).toBe(0);
        expect(fixture.snapshotStorage.get()).toBeUndefined();
    });

    it('rolls back when a collection does not persist the prepared value', () => {
        const fixture = createFixture();
        const originalProfiles = fixture.profilesStorage.get();
        fixture.profilesStorage.ignoreNextSet = true;

        expect(() => createService(fixture).changePassword(fixture.profile, oldPassword, newPassword, 'new hint')).toThrow(
            'persistence verification failed',
        );
        expect(fixture.profilesStorage.get()).toEqual(originalProfiles);
        expect(fixture.snapshotStorage.get()).toBeUndefined();
    });

    it('does not persist any collection when a key cannot be decrypted', () => {
        const fixture = createFixture();
        (fixture.harvestingStorage.get()[0] as any).newEncVrfPrivateKey = 'invalid ciphertext';

        const originalDecrypt = Crypto.decrypt;
        const decryptSpy = jest.spyOn(Crypto, 'decrypt').mockImplementation((value: string, password: string) => {
            if (value === 'invalid ciphertext') {
                throw new Error('decrypt failure');
            }
            return originalDecrypt(value, password);
        });

        expect(() => createService(fixture).changePassword(fixture.profile, oldPassword, newPassword, 'new hint')).toThrow(
            'decrypt failure',
        );
        expect(fixture.profilesStorage.setCalls).toBe(0);
        expect(fixture.accountsStorage.setCalls).toBe(0);
        expect(fixture.harvestingStorage.setCalls).toBe(0);
        decryptSpy.mockRestore();
    });
});
