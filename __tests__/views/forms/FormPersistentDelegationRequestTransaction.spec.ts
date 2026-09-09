/*
 * (C) Symbol Contributors 2022
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
 * See the License for the specific language governing permissions and limitations under the License.
 *
 */
import { AccountModel, AccountType } from '@/core/database/entities/AccountModel';
import { HarvestingModel } from '@/core/database/entities/HarvestingModel';
import { CommonHelpers } from '@/core/utils/CommonHelpers';
import i18n from '@/language/index';
import { HarvestingService } from '@/services/HarvestingService';
import { MultisigService } from '@/services/MultisigService';
import { ProfileService } from '@/services/ProfileService';
import { HarvestingModelStorage } from '@/core/database/storage/HarvestingModelStorage';
import { MosaicModelStorage } from '@/core/database/storage/MosaicModelStorage';
import { NetworkCurrenciesModelStorage } from '@/core/database/storage/NetworkCurrenciesModelStorage';
import { NetworkModelStorage } from '@/core/database/storage/NetworkModelStorage';
import { NodeModelStorage } from '@/core/database/storage/NodeModelStorage';
import FormPersistentDelegationRequestTransaction from '@/views/forms/FormPersistentDelegationRequestTransaction/FormPersistentDelegationRequestTransaction.vue';
import {
    account1,
    account1Params,
    account2,
    cosigner1AccountModel,
    cosigner2AccountModel,
    multisigAccountModel,
    WalletsModel1,
    WalletsModel2,
} from '@MOCKS/Accounts';
import { getHandlers, responses } from '@MOCKS/Http';
import { getTestProfile } from '@MOCKS/profiles';
import TestUIHelpers from '@MOCKS/testUtils/TestUIHelpers';
import userEvent from '@testing-library/user-event';
import { cleanup, screen, waitFor, within } from '@testing-library/vue';
import flushPromises from 'flush-promises';
import WS from 'jest-websocket-mock';
import { setupServer } from 'msw/node';
import { AccountInfo, Address, Convert, KeyPair } from 'symbol-sdk';
import { NodeWatchService } from '@/services/NodeWatchService';

// mock local storage
jest.mock('@/core/database/backends/LocalStorageBackend', () => ({
    LocalStorageBackend: jest.requireActual('@/core/database/backends/ObjectStorageBackend').ObjectStorageBackend,
}));

// Mock NodeWatchService responses
const nodeResponse = {
    endpoint: 'https://example.com:3001',
    friendlyName: 'Node1',
    mainPublicKey: '0'.repeat(64),
    nodePublicKey: '0'.repeat(64),
    isSslEnabled: true,
    isHealthy: true,
    restVersion: '1.0.0',
    wsUrl: 'wss://example.com:3001/ws',
};
jest.spyOn(NodeWatchService.prototype, 'getNodes').mockReturnValue(Promise.resolve([nodeResponse]));
const nodeWatchMainPublicKeySpy = jest
    .spyOn(NodeWatchService.prototype, 'getNodeByMainPublicKey')
    .mockReturnValue(Promise.resolve(nodeResponse));
jest.spyOn(NodeWatchService.prototype, 'getNodeByNodePublicKey').mockReturnValue(Promise.resolve(nodeResponse));

// mock http server with base responses denoted by * which are basic responses for the accounts __mock__/Accounts.ts
const httpServer = setupServer(
    ...getHandlers(responses['*']),
    ...getHandlers([
        {
            origin: '*',
            path: '/node/unlockedaccount',
            method: 'get',
            status: 200,
            body: [],
        },
        {
            origin: '*',
            path: '/node/unlockedaccount',
            method: 'options',
            status: 200,
            body: {},
        },
    ]),
);
// mock websocket server
const websocketServer = new WS('wss://example.com:3001/ws', { jsonProtocol: true });
websocketServer.on('connection', (socket) => {
    console.log('Websocket client connected!');
    socket.send('{"uid":"FAKE_UID"}');
});

type StoreLike = {
    dispatch: (action: string, payload?: unknown) => Promise<unknown>;
    getters: Record<string, unknown>;
    subscribeAction: (subscriber: {
        before?: (action: { type: string }) => void;
        after?: (action: { type: string }) => void;
        error?: (action: { type: string }) => void;
    }) => () => void;
};

type TrackedStore = {
    store: StoreLike;
    pendingActions: string[];
};

const storesToUninitialize = new Map<StoreLike, TrackedStore>();

const trackStore = (store: StoreLike) => {
    const existingStore = storesToUninitialize.get(store);
    if (existingStore) {
        return existingStore;
    }

    const trackedStore: TrackedStore = { store, pendingActions: [] };
    store.subscribeAction({
        before: ({ type }) => trackedStore.pendingActions.push(type),
        after: ({ type }) => {
            const actionIndex = trackedStore.pendingActions.indexOf(type);
            if (actionIndex >= 0) {
                trackedStore.pendingActions.splice(actionIndex, 1);
            }
        },
        error: ({ type }) => {
            const actionIndex = trackedStore.pendingActions.indexOf(type);
            if (actionIndex >= 0) {
                trackedStore.pendingActions.splice(actionIndex, 1);
            }
        },
    });
    storesToUninitialize.set(store, trackedStore);
    return trackedStore;
};

const drainPendingActions = async (trackedStore: TrackedStore) => {
    for (let attempt = 0; attempt < 40 && trackedStore.pendingActions.length > 0; attempt++) {
        await flushPromises();
        await CommonHelpers.sleep(25);
    }
    if (trackedStore.pendingActions.length > 0) {
        throw new Error(`Store cleanup left pending Vuex actions: ${trackedStore.pendingActions.join(', ')}`);
    }
};

const stopStoreSubscriptions = async (store: StoreLike) => {
    const currentAccountAddress = store.getters['account/currentAccountAddress'];
    if (currentAccountAddress) {
        await store.dispatch('account/UNSUBSCRIBE', currentAccountAddress);
    }
    await store.dispatch('network/UNSUBSCRIBE');
};

beforeAll(() => httpServer.listen({ onUnhandledRequest: 'error' }));
afterEach(async () => {
    const cleanupErrors: unknown[] = [];

    try {
        await flushPromises();
    } catch (error) {
        cleanupErrors.push(error);
    }

    try {
        cleanup();
    } catch (error) {
        cleanupErrors.push(error);
    }

    for (const trackedStore of storesToUninitialize.values()) {
        try {
            await stopStoreSubscriptions(trackedStore.store);
        } catch (error) {
            cleanupErrors.push(error);
        }
    }

    for (const trackedStore of storesToUninitialize.values()) {
        try {
            await drainPendingActions(trackedStore);
        } catch (error) {
            cleanupErrors.push(error);
        }
    }

    const generationHashes = new Set(
        Array.from(storesToUninitialize.values())
            .map(({ store }) => store.getters['network/generationHash'])
            .filter((generationHash): generationHash is string => typeof generationHash === 'string'),
    );
    for (const generationHash of generationHashes) {
        MosaicModelStorage.INSTANCE.remove(generationHash);
        NetworkCurrenciesModelStorage.INSTANCE.remove(generationHash);
        NetworkModelStorage.INSTANCE.remove(generationHash);
    }

    for (const trackedStore of storesToUninitialize.values()) {
        try {
            await trackedStore.store.dispatch('uninitialize');
        } catch (error) {
            cleanupErrors.push(error);
        }
    }
    for (const trackedStore of storesToUninitialize.values()) {
        try {
            await drainPendingActions(trackedStore);
        } catch (error) {
            cleanupErrors.push(error);
        }
    }
    storesToUninitialize.clear();
    HarvestingModelStorage.INSTANCE.remove();
    NodeModelStorage.INSTANCE.remove();
    localStorage.removeItem('mosaicCache');
    localStorage.removeItem('networkCurrencyCache');
    localStorage.removeItem('harvestingModels');
    httpServer.resetHandlers();
    jest.clearAllMocks();

    if (cleanupErrors.length > 0) {
        throw cleanupErrors[0];
    }
});
afterAll(() => {
    httpServer.close();
    websocketServer.close();
});

const testProfileName = 'profile1';
const testProfilePassword = 'Password1';
const sufficientAccountBalance = '10000000001';
const sufficientAccountImportance = '1';

describe('views/forms/FormPersistentDelegationRequestTransaction', () => {
    const renderPage = async (currentAccount: AccountModel, knownAccounts: string[]) => {
        const rendered = await TestUIHelpers.renderComponentWithStore(
            FormPersistentDelegationRequestTransaction,
            currentAccount,
            knownAccounts,
            testProfileName,
        );
        trackStore(rendered.store as StoreLike);
        return rendered;
    };

    const renderPageWithAccount = async (currentAccount: AccountModel, knownAccounts: AccountModel[]) => {
        const store = await TestUIHelpers.renderComponentWithAccount(
            FormPersistentDelegationRequestTransaction,
            currentAccount,
            knownAccounts,
            testProfileName,
            sufficientAccountBalance,
        );
        trackStore(store as StoreLike);
        return store;
    };

    test('renders component', async () => {
        // Arrange + Act:
        const currentAccountModel = WalletsModel1;
        await renderPage(currentAccountModel, [account1.address.plain(), account2.address.plain()]);

        // Assert:
        expect(await screen.findByText(i18n.t('tab_harvesting_delegated_harvesting').toString())).toBeDefined();
        expect(await screen.findByText(currentAccountModel.address)).toBeDefined();
    });

    describe('start/stop harvesting', () => {
        const testAccountBalance = async (balance: string, errorKey: string) => {
            // Arrange:
            const currentAccountModel = WalletsModel1;
            const accountBalance = balance;
            httpServer.use(
                ...getHandlers([TestUIHelpers.getAccountsHttpResponse(currentAccountModel, 'post', undefined, () => accountBalance)]),
            );

            const { store } = await renderPage(currentAccountModel, [account1.address.plain(), account2.address.plain()]);
            await screen.findByText(
                MultisigService.getAccountLabel(
                    Address.createFromRawAddress(currentAccountModel.address),
                    store.getters['account/knownAccounts'],
                ),
            );
            await waitFor(() => expect(store.getters['mosaic/networkBalanceMosaics'].balance.toString()).toBe(accountBalance));

            // Act:
            const input = screen.getByPlaceholderText(i18n.t('form_label_network_node_url').toString());
            await userEvent.type(input, 'https://001-joey-dual.symboltest.net:3001');
            const button = screen.getByRole('button', { name: i18n.t('start_harvesting').toString() });
            await userEvent.click(button);
            const confirmButtonInModal = await screen.findByRole('button', { name: i18n.t('confirm').toString() });
            await userEvent.click(confirmButtonInModal);

            // Assert:
            await TestUIHelpers.expectToastMessage(errorKey, 'error', 6000);
        };

        test('insufficient balance error is thrown', async () => {
            const insufficientBalance = '9999000000';
            await testAccountBalance(insufficientBalance, 'harvesting_account_insufficient_balance');
        });

        test('extra balance error is thrown', async () => {
            const extraBalance = '50000000000000';
            await testAccountBalance(extraBalance, 'harvesting_account_has_extra_balance');
        });

        test('importance is zero error is thrown', async () => {
            // Arrange:
            const currentAccountModel = WalletsModel1;
            const accountImportance = '0';
            httpServer.use(
                ...getHandlers([
                    TestUIHelpers.getAccountsHttpResponse(
                        currentAccountModel,
                        'post',
                        undefined,
                        () => sufficientAccountBalance,
                        () => accountImportance,
                    ),
                ]),
            );

            const { store } = await renderPage(currentAccountModel, [account1.address.plain(), account2.address.plain()]);
            await screen.findByText(
                MultisigService.getAccountLabel(
                    Address.createFromRawAddress(currentAccountModel.address),
                    store.getters['account/knownAccounts'],
                ),
            );
            await waitFor(() => expect(store.getters['mosaic/networkBalanceMosaics'].balance.toString()).toBe(sufficientAccountBalance));

            // Act:
            const input = await screen.findByPlaceholderText(i18n.t('form_label_network_node_url').toString());
            await userEvent.type(input, 'https://001-joey-dual.symboltest.net:3001');
            const button = await screen.findByRole('button', { name: 'Start Harvesting' });
            await userEvent.click(button);
            const confirmButtonInModal = await screen.findByRole('button', { name: i18n.t('confirm').toString() });
            await userEvent.click(confirmButtonInModal);

            // Assert:
            await TestUIHelpers.expectToastMessage('harvesting_account_has_zero_importance', 'error', 6000);
        });

        const testStartStopHarvestingWithAccount = async (
            currentAccountModel: AccountModel,
            knownAccountModels: AccountModel[],
            currentSignerAccountModel?: AccountModel,
            needToUnlockProfile = false,
            selectedMaxFee = 'slow',
        ) => {
            // test: start harvesting
            // Arrange:
            const store = await renderPageWithAccount(currentAccountModel, knownAccountModels);

            if (currentSignerAccountModel && currentAccountModel.address !== currentSignerAccountModel.address) {
                await TestUIHelpers.selectMultisigAccount(
                    currentSignerAccountModel.address,
                    currentAccountModel.address,
                    store,
                    sufficientAccountBalance,
                );
            }

            // Act:
            const input = await screen.findByPlaceholderText(i18n.t('form_label_network_node_url').toString());
            await userEvent.type(input, 'https://example.com:3001');
            await TestUIHelpers.selectMaxFee(selectedMaxFee);
            const button = await screen.findByRole('button', { name: i18n.t('start_harvesting').toString() });
            await userEvent.click(button);
            const confirmButtonInModal = await screen.findByRole('button', { name: i18n.t('confirm').toString() });
            await userEvent.click(confirmButtonInModal);
            if (needToUnlockProfile) {
                await TestUIHelpers.unlockProfile(testProfilePassword);
            }
            await TestUIHelpers.confirmTransactions(testProfilePassword);

            // Assert:
            await TestUIHelpers.expectToastMessage('success_transactions_signed', 'success');

            httpServer.use(
                ...getHandlers([
                    TestUIHelpers.getAccountsHttpResponse(
                        currentSignerAccountModel ? currentSignerAccountModel : currentAccountModel,
                        'post',
                        () => {
                            const harvestingModel: HarvestingModel = store.getters['harvesting/currentSignerHarvestingModel'];
                            return {
                                linked: { publicKey: harvestingModel?.newRemotePublicKey },
                                vrf: { publicKey: harvestingModel?.newVrfPublicKey },
                                node: { publicKey: harvestingModel?.newSelectedHarvestingNode?.nodePublicKey },
                            };
                        },
                        () => sufficientAccountBalance,
                        () => sufficientAccountImportance,
                    ),
                    {
                        origin: '*',
                        path: '/node/unlockedaccount',
                        method: 'get',
                        status: 200,
                        body: () => {
                            const harvestingModel: HarvestingModel = store.getters['harvesting/currentSignerHarvestingModel'];
                            return { unlockedAccount: [harvestingModel?.newRemotePublicKey] };
                        },
                    },
                ]),
            );
            // in order to trigger account/currentSignerAccountInfo update
            await store.dispatch('account/LOAD_ACCOUNT_INFO');

            await waitFor(() => expect(store.getters['harvesting/status']).toBe('ACTIVE'), { timeout: 3_000 });
            const stopButton = await screen.findByRole('button', { name: i18n.t('stop_harvesting').toString() }, { timeout: 3_000 });
            expect(stopButton).toBeDefined();

            // test: stop harvesting
            // Arrange:
            httpServer.use(
                ...getHandlers([
                    TestUIHelpers.getAccountsHttpResponse(
                        currentSignerAccountModel ? currentSignerAccountModel : currentAccountModel,
                        'post',
                        undefined,
                        () => sufficientAccountBalance,
                        () => sufficientAccountImportance,
                    ),
                    {
                        origin: '*',
                        path: '/node/unlockedaccount',
                        method: 'get',
                        status: 200,
                        body: () => [],
                    },
                ]),
            );

            // Act:
            await userEvent.click(stopButton);
            await TestUIHelpers.confirmTransactions(testProfilePassword);
            // in order to trigger account/currentSignerAccountInfo update
            await store.dispatch('account/LOAD_ACCOUNT_INFO');

            // Assert:
            await waitFor(() => expect(store.getters['harvesting/status']).toBe('INACTIVE'), { timeout: 3_000 });
            expect(await screen.findByRole('button', { name: i18n.t('start_harvesting').toString() })).toBeDefined();
        };

        test('regular account - harvesting is successfully started and stopped', async () => {
            const knownAccountModels = [WalletsModel1, WalletsModel2];
            const currentAccountModel = WalletsModel1;
            await testStartStopHarvestingWithAccount(currentAccountModel, knownAccountModels, undefined, false, 'fast');
            await CommonHelpers.sleep(2_000);
        });

        test('regular account - harvesting is successfully started and stopped when account is already linked', async () => {
            const knownAccountModels = [WalletsModel1, WalletsModel2];
            const currentAccountModel = WalletsModel1;
            const harvestingModel = {
                accountAddress: 'TBUYPO5DPOWXFVB7TNMDMBRFJBG5FGTXNKKZB7I',
                newEncVrfPrivateKey:
                    'b8483ec1d0934347dbd1cdc66259ed7bc0826834b8b89afa73678dca7818880cMjt+9kHHWs9vjFnSOnBiK6GVH0AXg0dKOVEXZyEBqqurvOIA1MQR7dzAlfSLFVPRVfIi+fG5JsPYJ4J+UdFLwDuIMNd2ZqImg0+L2/bAQ5s=',
                newVrfPublicKey: '2F23F5F5768EDEE9199F0CB29FEB8508CEC3BCAF0033CD3F442D67999FC70A65',
                newEncRemotePrivateKey:
                    '71dd0b7057fc81aa7c87966599650b06234dbcc1b8e132d045f4e28c8aa6c591De+Ujsfjrt2T6xC+R9Rl/6LdgEbOrftpmqSchCRs4sc0/SdAN3WQ2FeVPIjfNa4AeZVM21qqVU9s1zb/2u3TolqYok6SYsr+zLND3H+s+78=',
                newRemotePublicKey: '1069B61D621FB818B2A756A12BCE02F1BC45AEF8E28618EF5BC1FCE8FF915838',
                selectedHarvestingNode: {
                    url: 'https://001-joey-dual.symboltest.net:3001',
                    friendlyName: '001-joey-dual',
                    isDefault: true,
                    networkType: 152,
                    publicKey: 'AAA1922FA60DB681092CBE70A9A1BAB85745025310AE7567F95EA7FD05B3D3FC',
                    nodePublicKey: '05E5C0841720AE9DA737C184429002E917F74FF7A3BF8E11AC2862C4875B3D7E',
                    wsUrl: 'wss://001-joey-dual.symboltest.net:3001/ws',
                },
                delegatedHarvestingRequestFailed: false,
                newSelectedHarvestingNode: {
                    url: 'https://001-joey-dual.symboltest.net:3001',
                    friendlyName: '001-joey-dual',
                    isDefault: true,
                    networkType: 152,
                    publicKey: 'AAA1922FA60DB681092CBE70A9A1BAB85745025310AE7567F95EA7FD05B3D3FC',
                    nodePublicKey: '05E5C0841720AE9DA737C184429002E917F74FF7A3BF8E11AC2862C4875B3D7E',
                    wsUrl: 'wss://001-joey-dual.symboltest.net:3001/ws',
                },
                encRemotePrivateKey:
                    '71dd0b7057fc81aa7c87966599650b06234dbcc1b8e132d045f4e28c8aa6c591De+Ujsfjrt2T6xC+R9Rl/6LdgEbOrftpmqSchCRs4sc0/SdAN3WQ2FeVPIjfNa4AeZVM21qqVU9s1zb/2u3TolqYok6SYsr+zLND3H+s+78=',
                encVrfPrivateKey:
                    'b8483ec1d0934347dbd1cdc66259ed7bc0826834b8b89afa73678dca7818880cMjt+9kHHWs9vjFnSOnBiK6GVH0AXg0dKOVEXZyEBqqurvOIA1MQR7dzAlfSLFVPRVfIi+fG5JsPYJ4J+UdFLwDuIMNd2ZqImg0+L2/bAQ5s=',
                isPersistentDelReqSent: false,
            };
            new HarvestingService().saveHarvestingModel(harvestingModel);
            httpServer.use(
                ...getHandlers([
                    TestUIHelpers.getAccountsHttpResponse(
                        currentAccountModel,
                        'post',
                        () => {
                            return {
                                linked: { publicKey: harvestingModel?.newRemotePublicKey },
                                vrf: { publicKey: harvestingModel?.newVrfPublicKey },
                                node: { publicKey: harvestingModel?.newSelectedHarvestingNode?.nodePublicKey },
                            };
                        },
                        () => sufficientAccountBalance,
                        () => sufficientAccountImportance,
                    ),
                ]),
            );
            await testStartStopHarvestingWithAccount(currentAccountModel, knownAccountModels, undefined, true);
        });

        test('regular account - when account is a node operator', async () => {
            const knownAccountModels = [WalletsModel1, WalletsModel2];
            const currentAccountModel = WalletsModel1;

            const nodeOperatorResponse = {
                ...nodeResponse,
                endpoint: 'https://001-joey-dual.symboltest.net:3001',
                friendlyName: '001-joey-dual',
                mainPublicKey: currentAccountModel.publicKey,
                nodePublicKey: '05E5C0841720AE9DA737C184429002E917F74FF7A3BF8E11AC2862C4875B3D7E',
                wsUrl: 'wss://001-joey-dual.symboltest.net:3001/ws',
            };
            nodeWatchMainPublicKeySpy.mockImplementation(async (publicKey) => {
                return publicKey === currentAccountModel.publicKey ? nodeOperatorResponse : nodeResponse;
            });
            try {
                await testStartStopHarvestingWithAccount(currentAccountModel, knownAccountModels, undefined, false);
            } finally {
                nodeWatchMainPublicKeySpy.mockReturnValue(Promise.resolve(nodeResponse));
            }
        });

        test('multisig account with 1 required cosignature - harvesting is successfully started and stopped', async () => {
            // default responses for the following accounts in __mock__/Http.ts for 1 of 2 approvals and 1 of 2 removals multisig structure
            const knownAccountModels = [cosigner1AccountModel, cosigner2AccountModel, multisigAccountModel];
            const currentAccountModel = cosigner1AccountModel;
            await testStartStopHarvestingWithAccount(currentAccountModel, knownAccountModels, multisigAccountModel);
        });

        test('multisig account with 2 required cosignatures - harvesting is successfully started and stopped', async () => {
            httpServer.use(...getHandlers(responses['multisig-2-2']));
            const knownAccountModels = [cosigner1AccountModel, cosigner2AccountModel, multisigAccountModel];
            const currentAccountModel = cosigner1AccountModel;
            await testStartStopHarvestingWithAccount(currentAccountModel, knownAccountModels, multisigAccountModel);
        });
    });

    const testLinkUnlinkNodePublicKey = async (
        currentAccountModel: AccountModel,
        knownAccountModels: AccountModel[],
        currentSignerAccountModel?: AccountModel,
    ) => {
        // Test: link action
        // Arrange:
        const nodePublicKey = '05E5C0841720AE9DA737C184429002E917F74FF7A3BF8E11AC2862C4875B3D7E';

        const store = await renderPageWithAccount(currentAccountModel, knownAccountModels);

        if (currentSignerAccountModel && currentAccountModel.address !== currentSignerAccountModel.address) {
            await TestUIHelpers.selectMultisigAccount(
                currentSignerAccountModel.address,
                currentAccountModel.address,
                store,
                sufficientAccountBalance,
            );
        }

        // Act:
        const input = await screen.findByPlaceholderText(i18n.t('form_label_network_node_url').toString());
        await userEvent.type(input, 'https://example.com:3001');
        const keyLinksTab = await screen.findByText(i18n.t('tab_harvesting_key_links').toString());
        await userEvent.click(keyLinksTab);

        expect(await screen.findByText(i18n.t('open_harvesting_keys_warning_title').toString())).toBeDefined();
        const confirmButton = await screen.findByRole('button', { name: i18n.t('confirm').toString() });
        await userEvent.click(confirmButton);
        expect(await screen.findByText(i18n.t('delegated_harvesting_keys_info').toString())).toBeDefined();
        httpServer.use(
            ...getHandlers([
                TestUIHelpers.getAccountsHttpResponse(
                    currentSignerAccountModel ? currentSignerAccountModel : currentAccountModel,
                    'post',
                    () => ({
                        node: { publicKey: nodePublicKey },
                    }),
                    () => sufficientAccountBalance,
                    () => sufficientAccountImportance,
                ),
            ]),
        );
        const nodeLinkButton = await screen.findByTestId('btn_linkNodeKey');
        await userEvent.click(nodeLinkButton);
        await TestUIHelpers.confirmTransactions(testProfilePassword);

        // Assert:
        await TestUIHelpers.expectToastMessage('success_transactions_signed', 'success');
        // in order to trigger account/currentSignerAccountInfo update
        await store.dispatch('account/LOAD_ACCOUNT_INFO');

        await waitFor(
            async () => {
                return expect((await within(await screen.findByTestId('nodePublicKeyDisplay')).findByText(nodePublicKey)).textContent).toBe(
                    nodePublicKey,
                );
            },
            { timeout: 3_000 },
        );

        // Test: unlink action
        // Arrange + Act:
        httpServer.use(
            ...getHandlers([
                TestUIHelpers.getAccountsHttpResponse(
                    currentSignerAccountModel ? currentSignerAccountModel : currentAccountModel,
                    'post',
                    () => ({}),
                    () => sufficientAccountBalance,
                    () => sufficientAccountImportance,
                ),
            ]),
        );
        const nodeUnlinkButton = await screen.findByTestId('btn_unlinkNodeKey');
        await userEvent.click(nodeUnlinkButton);
        await TestUIHelpers.confirmTransactions(testProfilePassword);

        // in order to trigger account/currentSignerAccountInfo update
        await store.dispatch('account/LOAD_ACCOUNT_INFO');
        await waitFor(() => expect(store.getters['harvesting/status']).toBe('INACTIVE'), { timeout: 3_000 });

        // Assert:
        await waitFor(() => expect(screen.queryByTestId('nodePublicKeyDisplay')).toBeNull(), {
            timeout: 3_000,
        });
    };

    const testLinkUnlinkAccountPublicKey = async (
        currentAccountModel: AccountModel,
        knownAccountModels: AccountModel[],
        currentSignerAccountModel?: AccountModel,
        privateKeyToBeImported?: string,
        isLedger = false,
    ) => {
        // Test: link action
        // Arrange:
        const store = await renderPageWithAccount(currentAccountModel, knownAccountModels);

        if (currentSignerAccountModel && currentAccountModel.address !== currentSignerAccountModel.address) {
            await TestUIHelpers.selectMultisigAccount(
                currentSignerAccountModel.address,
                currentAccountModel.address,
                store,
                sufficientAccountBalance,
            );
        }

        // Act:
        const keyLinksTab = await screen.findByText(i18n.t('tab_harvesting_key_links').toString());
        await userEvent.click(keyLinksTab);

        expect(await screen.findByText(i18n.t('open_harvesting_keys_warning_title').toString())).toBeDefined();
        let confirmButton = await screen.findByRole('button', { name: i18n.t('confirm').toString() });
        await userEvent.click(confirmButton);
        expect(await screen.findByText(i18n.t('delegated_harvesting_keys_info').toString())).toBeDefined();
        httpServer.use(
            ...getHandlers([
                TestUIHelpers.getAccountsHttpResponse(
                    currentSignerAccountModel ? currentSignerAccountModel : currentAccountModel,
                    'post',
                    () => {
                        const harvestingModel: HarvestingModel = store.getters['harvesting/currentSignerHarvestingModel'];
                        return {
                            linked: { publicKey: harvestingModel.newRemotePublicKey },
                        };
                    },
                    () => sufficientAccountBalance,
                    () => sufficientAccountImportance,
                ),
            ]),
        );
        const nodeLinkButton = await screen.findByTestId('btn_linkAccountKey');
        await userEvent.click(nodeLinkButton);
        await userEvent.click(await screen.findByText('Select'));
        if (privateKeyToBeImported) {
            await userEvent.click(await screen.findByText(i18n.t('import_key_manually').toString()));
            const privateKeyInput = await screen.findByTestId('privateKey');
            await userEvent.type(privateKeyInput, privateKeyToBeImported);
        } else {
            await userEvent.click(await screen.findByText(i18n.t('generate_random_public_key').toString()));
        }
        confirmButton = await screen.findByRole('button', { name: i18n.t('confirm').toString() });
        await userEvent.click(confirmButton);

        if (isLedger) {
            await TestUIHelpers.unlockProfile(testProfilePassword);
            // end of test for the ledger case
            return;
        }
        await TestUIHelpers.confirmTransactions(testProfilePassword);

        // Assert:
        await TestUIHelpers.expectToastMessage('success_transactions_signed', 'success');
        // in order to trigger account/currentSignerAccountInfo update
        await store.dispatch('account/LOAD_ACCOUNT_INFO');
        let remoteAccountPublicKey;
        await waitFor(
            async () => {
                const currentSignerAccountInfo: AccountInfo = store.getters['account/currentSignerAccountInfo'];
                if (!currentSignerAccountInfo?.supplementalPublicKeys?.linked?.publicKey) {
                    return undefined;
                }
                remoteAccountPublicKey = currentSignerAccountInfo?.supplementalPublicKeys?.linked?.publicKey;
                if (privateKeyToBeImported) {
                    expect(Convert.uint8ToHex(KeyPair.createKeyPairFromPrivateKeyString(privateKeyToBeImported).publicKey)).toBe(
                        remoteAccountPublicKey,
                    );
                }
                return expect(
                    await within(await screen.findByTestId('accountPublicKeyDisplay')).findByText(remoteAccountPublicKey),
                ).toBeDefined();
            },
            { timeout: 3_000 },
        );

        // Test: unlink action
        // Arrange + Act:
        httpServer.use(
            ...getHandlers([
                TestUIHelpers.getAccountsHttpResponse(
                    currentSignerAccountModel ? currentSignerAccountModel : currentAccountModel,
                    'post',
                    () => ({}),
                    () => sufficientAccountBalance,
                    () => sufficientAccountImportance,
                ),
            ]),
        );
        const nodeUnlinkButton = await screen.findByTestId('btn_unlinkAccountKey');
        await userEvent.click(nodeUnlinkButton);
        await TestUIHelpers.confirmTransactions(testProfilePassword);

        // in order to trigger account/currentSignerAccountInfo update
        await store.dispatch('account/LOAD_ACCOUNT_INFO');
        await waitFor(() => expect(store.getters['harvesting/status']).toBe('INACTIVE'), { timeout: 3_000 });

        // Assert:
        await waitFor(() => expect(screen.queryByTestId('accountPublicKeyDisplay')).toBeNull(), { timeout: 3_000 });
    };

    const testLinkUnlinkVrfPublicKey = async (
        currentAccountModel: AccountModel,
        knownAccountModels: AccountModel[],
        currentSignerAccountModel?: AccountModel,
    ) => {
        // Test: link action
        // Arrange:
        const store = await renderPageWithAccount(currentAccountModel, knownAccountModels);

        if (currentSignerAccountModel && currentAccountModel.address !== currentSignerAccountModel.address) {
            await TestUIHelpers.selectMultisigAccount(
                currentSignerAccountModel.address,
                currentAccountModel.address,
                store,
                sufficientAccountBalance,
            );
        }

        // Act:
        const keyLinksTab = await screen.findByText(i18n.t('tab_harvesting_key_links').toString());
        await userEvent.click(keyLinksTab);

        expect(await screen.findByText(i18n.t('open_harvesting_keys_warning_title').toString())).toBeDefined();
        let confirmButton = await screen.findByRole('button', { name: i18n.t('confirm').toString() });
        await userEvent.click(confirmButton);
        expect(await screen.findByText(i18n.t('delegated_harvesting_keys_info').toString())).toBeDefined();
        httpServer.use(
            ...getHandlers([
                TestUIHelpers.getAccountsHttpResponse(
                    currentSignerAccountModel ? currentSignerAccountModel : currentAccountModel,
                    'post',
                    () => {
                        const harvestingModel: HarvestingModel = store.getters['harvesting/currentSignerHarvestingModel'];
                        return {
                            vrf: { publicKey: harvestingModel.newVrfPublicKey },
                        };
                    },
                    () => sufficientAccountBalance,
                    () => sufficientAccountImportance,
                ),
            ]),
        );
        const nodeLinkButton = await screen.findByTestId('btn_linkVrfKey');
        await userEvent.click(nodeLinkButton);
        await userEvent.click(await screen.findByText('Select'));
        await userEvent.click(await screen.findByText(i18n.t('generate_random_public_key').toString()));
        confirmButton = await screen.findByRole('button', { name: i18n.t('confirm').toString() });
        await userEvent.click(confirmButton);

        await TestUIHelpers.confirmTransactions(testProfilePassword);

        // Assert:
        await TestUIHelpers.expectToastMessage('success_transactions_signed', 'success');
        // in order to trigger account/currentSignerAccountInfo update
        await store.dispatch('account/LOAD_ACCOUNT_INFO');
        let vrfPublicKey;
        await waitFor(
            async () => {
                const currentSignerAccountInfo: AccountInfo = store.getters['account/currentSignerAccountInfo'];
                if (!currentSignerAccountInfo?.supplementalPublicKeys?.vrf?.publicKey) {
                    return undefined;
                }
                vrfPublicKey = currentSignerAccountInfo?.supplementalPublicKeys?.vrf?.publicKey;
                return expect(await within(await screen.findByTestId('vrfPublicKeyDisplay')).findByText(vrfPublicKey)).toBeDefined();
            },
            { timeout: 3_000 },
        );

        // Test: unlink action
        // Arrange + Act:
        httpServer.use(
            ...getHandlers([
                TestUIHelpers.getAccountsHttpResponse(
                    currentSignerAccountModel ? currentSignerAccountModel : currentAccountModel,
                    'post',
                    () => ({}),
                    () => sufficientAccountBalance,
                    () => sufficientAccountImportance,
                ),
            ]),
        );
        const nodeUnlinkButton = await screen.findByTestId('btn_unlinkVrfKey');
        await userEvent.click(nodeUnlinkButton);
        await TestUIHelpers.confirmTransactions(testProfilePassword);

        // in order to trigger account/currentSignerAccountInfo update
        await store.dispatch('account/LOAD_ACCOUNT_INFO');
        await waitFor(() => expect(store.getters['harvesting/status']).toBe('INACTIVE'), { timeout: 3_000 });

        // Assert:
        await waitFor(() => expect(screen.queryByTestId('vrfPublicKeyDisplay')).toBeNull(), {
            timeout: 3_000,
        });
    };

    describe('single key link transactions', () => {
        test('regular account - link/unlink node public key', async () => {
            const knownAccountModels = [WalletsModel1, WalletsModel2];
            const currentAccountModel = WalletsModel1;
            await testLinkUnlinkNodePublicKey(currentAccountModel, knownAccountModels);
        });

        test('multisig account - link/unlink node public key', async () => {
            const knownAccountModels = [cosigner1AccountModel, cosigner2AccountModel, multisigAccountModel];
            const currentAccountModel = cosigner1AccountModel;
            await testLinkUnlinkNodePublicKey(currentAccountModel, knownAccountModels, multisigAccountModel);
        });

        test('regular account - link/unlink generated account public key', async () => {
            const knownAccountModels = [WalletsModel1, WalletsModel2];
            const currentAccountModel = WalletsModel1;
            await testLinkUnlinkAccountPublicKey(currentAccountModel, knownAccountModels);
        });

        test('regular account - link/unlink imported account public key', async () => {
            const knownAccountModels = [WalletsModel1, WalletsModel2];
            const currentAccountModel = WalletsModel1;
            await testLinkUnlinkAccountPublicKey(currentAccountModel, knownAccountModels, undefined, account1Params.privateKey);
        });

        test('regular account - link/unlink imported account public key when using Ledger', async () => {
            const knownAccountModels = [
                { ...WalletsModel1, type: AccountType.LEDGER },
                { ...WalletsModel2, type: AccountType.LEDGER },
            ];
            const currentAccountModel = knownAccountModels[0];
            jest.spyOn(ProfileService.prototype, 'getProfileByName').mockImplementation((profileName) => getTestProfile(profileName));
            await testLinkUnlinkAccountPublicKey(currentAccountModel, knownAccountModels, undefined, account1Params.privateKey, true);
        });

        test('multisig account - link/unlink account public key', async () => {
            const knownAccountModels = [cosigner1AccountModel, cosigner2AccountModel, multisigAccountModel];
            const currentAccountModel = cosigner1AccountModel;
            await testLinkUnlinkAccountPublicKey(currentAccountModel, knownAccountModels, multisigAccountModel);
        });

        test('regular account - link/unlink vrf public key', async () => {
            const knownAccountModels = [WalletsModel1, WalletsModel2];
            const currentAccountModel = WalletsModel1;
            await testLinkUnlinkVrfPublicKey(currentAccountModel, knownAccountModels);
        });

        test('multisig account - link/unlink vrf public key', async () => {
            const knownAccountModels = [cosigner1AccountModel, cosigner2AccountModel, multisigAccountModel];
            const currentAccountModel = cosigner1AccountModel;
            await testLinkUnlinkVrfPublicKey(currentAccountModel, knownAccountModels, multisigAccountModel);
        });
    });
});
