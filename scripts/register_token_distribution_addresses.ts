import * as fs from 'fs';
import * as BigNumber from 'bignumber.js';
import * as yargs from 'yargs';
import * as Web3 from 'web3';
import * as _ from 'lodash';
import * as Confirm from 'prompt-confirm';
import contract = require('truffle-contract');
import promisify = require('es6-promisify');
import * as TokenSale from '../build/contracts/TokenSale.json';

const DEFAULT_NODE_URL = 'http://localhost:8545';
const DEFAULT_GAS_PRICE = 21000000000;
const DEFAULT_GAS_LIMIT = 1000000;

export interface TxOpts {
    from: string;
    gas?: number;
}

interface TokenDistributionWithRegistry extends ContractInstance {
    changeRegistrationStatuses: {
        (addresses: string[], isregistered: boolean, txOpts: TxOpts): Promise<void>;
        estimateGas: (addresses: string[], isregistered: boolean, txOpts: TxOpts) => Promise<number>;
    };
    registered: {
        call: (address: string) => Promise<boolean>;
    };
    owner: {
        call: () => Promise<string>;
    };
}

interface BatchConfig {
    size: number;
    gasUsage: number;
}

const log = (...args: any[]) => {
    // tslint:disable-next-line:no-console
    console.log(...args);
};

const getRandomAddress = () => {
    return '0x' +
            Math.random().toString(16).substr(2, 8) +
            Math.random().toString(16).substr(2, 8) +
            Math.random().toString(16).substr(2, 8) +
            Math.random().toString(16).substr(2, 8) +
            Math.random().toString(16).substr(2, 8);
};

const getRandomAddresses = (n: number) => _.times(n, getRandomAddress);

class RegistrationManager {
    private tokenDistributionWithRegistry: TokenDistributionWithRegistry;
    private registeringAddress: string;
    private gasPrice: number;
    constructor(tokenDistributionWithRegistry: TokenDistributionWithRegistry,
                registeringAddress: string,
                gasPrice: number) {
        this.tokenDistributionWithRegistry = tokenDistributionWithRegistry;
        this.registeringAddress = registeringAddress;
        this.gasPrice = gasPrice;
    }
    public async getGasUsageByBatchSizeAsync(batchSize: number): Promise<number> {
        const isRegistered = true;
        const addresses = getRandomAddresses(batchSize);
        const txOpts = {from: this.registeringAddress};
        try {
            const gasUsage = await this.tokenDistributionWithRegistry.changeRegistrationStatuses.estimateGas(
               addresses, isRegistered, txOpts);
            return gasUsage;
        } catch (e) {
            // This happens when gas usage would be bigger than block gas limit
            return Infinity;
        }
    }
    // Binary searches for the biggest batch size below the gasLimit
    public async getBatchConfigByGasLimitAsync(gasLimit: number): Promise<BatchConfig> {
        const singleRegistrationGasUsage = await this.getGasUsageByBatchSizeAsync(1);
        if (gasLimit < singleRegistrationGasUsage) {
            throw new Error('Your gas limit is not enough to register a single address');
        }
        let amountWeCanRegister = 1;
        let amountWeCanNotRegister = 400; // Approx 9kk gas
        let gasUsage = singleRegistrationGasUsage;
        while (amountWeCanNotRegister - amountWeCanRegister > 1) {
            const testAmount = Math.floor((amountWeCanRegister + amountWeCanNotRegister) / 2);
            const gas = await this.getGasUsageByBatchSizeAsync(testAmount);
            if (gas <= gasLimit) {
                amountWeCanRegister = testAmount;
                gasUsage = gas;
            } else {
                amountWeCanNotRegister = testAmount;
            }
        }
        const batchConfig = {
            size: amountWeCanRegister,
            gasUsage,
        };
        return batchConfig;
    }
    public async registerBatchOfAddressesAsync(batch: string[], gas: number): Promise<void> {
        const isRegistered = true;
        const txOpts = {from: this.registeringAddress, gas, gasPrice: this.gasPrice};
        await this.tokenDistributionWithRegistry.changeRegistrationStatuses(batch, isRegistered, txOpts);
    }
    public async registerAddressesInBatchesAsync(batches: string[][], gas: number): Promise<void> {
        for (const [index, batch] of batches.entries()) {
            log(`Registered batches: ${index}/${batches.length} ✅`);
            await this.registerBatchOfAddressesAsync(batch, gas);
        }
        log('Registration succeeded ✅');
    };
    public async isRegistered(address: string): Promise<boolean> {
        const isRegistered = await this.tokenDistributionWithRegistry.registered.call(address);
        return isRegistered;
    }
    public async getUnregisteredAddressesAsync(addresses: string[]): Promise<string[]> {
        const unregisteredAddresses = [];
        for (const [index, address] of addresses.entries()) {
            const isRegistered = await this.isRegistered(address);
            if (!isRegistered) {
                unregisteredAddresses.push(address);
            }
        }
        return unregisteredAddresses;
    }
};

(async () => {
    const args = yargs
        .option('node_url', {
          type: 'string',
          default: DEFAULT_NODE_URL,
        })
        .option('gas_price', {
          type: 'number',
          default: DEFAULT_GAS_PRICE,
          description: 'Gas price in wei',
        })
        .option('gas_limit', {
          type: 'number',
          default: DEFAULT_GAS_LIMIT,
          describe: 'Max gas limit for every batch/transaction',
        })
        .option('batch_size', {
          type: 'number',
          description: 'If batch size is undefined - uses gas_limit to determine batch size',
        })
        .option('file_path', {
          type: 'string',
          demand: true,
          description: 'Should be a JSON array of addresses',
        })
        .argv;

    const NODE_URL = args.node_url;
    log(`Using node: ${NODE_URL}`);
    const provider = new Web3.providers.HttpProvider(NODE_URL);
    const tokenSaleArtifacts = TokenSale as any as Artifact;
    const contractFactory = contract(tokenSaleArtifacts);
    contractFactory.setProvider(provider);
    const tokenSale = await contractFactory.deployed() as TokenDistributionWithRegistry;

    const registeringAddress = await tokenSale.owner.call();
    const registrationManager = new RegistrationManager(
        tokenSale, registeringAddress, args.gas_price);
    let batchConfig;
    if (!_.isUndefined(args.batch_size)) {
        const batchSize = Number(args.batch_size);
        const gasUsage = await registrationManager.getGasUsageByBatchSizeAsync(batchSize);
        batchConfig = {
            size: batchSize,
            gasUsage,
        };
    } else {
        log('Calculating the batch size');
        batchConfig = await registrationManager.getBatchConfigByGasLimitAsync(args.gas_limit);
    }
    log(`Batch size: ${batchConfig.size}. Gas per batch ${batchConfig.gasUsage}`);
    const addresses = JSON.parse(fs.readFileSync(args.file_path).toString());
    log(`Number of addresses: ${addresses.length}`);

    const filteringPrompt = new Confirm('Would you like to filter out the addresses that are already registered?');
    const shouldFilter = await filteringPrompt.run();
    let unregisteredAddresses: string[] = [];
    if (shouldFilter) {
        unregisteredAddresses = await registrationManager.getUnregisteredAddressesAsync(addresses);
        _.map(addresses, (address: string, index: number) => {
            const isRegistered = !_.includes(unregisteredAddresses, address);
            const registrationStatus = isRegistered ? '🔴' : '⚪';
            log(`Registration status: ${index}/${addresses.length} ${address} ${registrationStatus}`);
        });
    } else {
        unregisteredAddresses = addresses;
    }
    log(`Number of unregistered addresses: ${unregisteredAddresses.length}`);
    // The last chunk might be smaller than others
    const batches = _.chunk(unregisteredAddresses, batchConfig.size);
    log(`Number of batches/transactions: ${batches.length}`);

    const prompt = new Confirm('Would you like to start registering addresses?');
    const shouldRun = await prompt.run();
    if (!shouldRun) {
        return;
    }
    await registrationManager.registerAddressesInBatchesAsync(batches, batchConfig.gasUsage);
})().catch(log);
