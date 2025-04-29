import { z } from "zod";
import { ActionProvider } from "../actionProvider";
import { EvmWalletProvider } from "../../wallet-providers/evmWalletProvider";
import { CreateCoinSchema } from "./schemas";
import { CreateAction } from "../actionDecorator";
import { PublicClient, Hex, createPublicClient, http, createWalletClient, WalletClient } from "viem";
import { base } from "viem/chains";
import { Network } from "../../network";
import { privateKeyToAccount } from "viem/accounts";

const SUPPORTED_NETWORKS = ["base-mainnet", "base-sepolia"];

export interface ZoraActionProviderConfig {
  /**
   * RPC URL to use for public client
   */
  RPC_URL?: string;
  /**
   * Private key of the wallet provider
   */
  privateKey: string;
}

/**
 * ZoraActionProvider provides actions for interacting with the Zora protocol.
 */
export class ZoraActionProvider extends ActionProvider<EvmWalletProvider> {
  #publicClient: PublicClient;
  #privateKey: string;
  #walletClient: WalletClient;
  #account: ReturnType<typeof privateKeyToAccount>;

  /**
   * Constructor for the ZoraActionProvider.
   *
   * @param config - The configuration options for the ZoraActionProvider.
   */
  constructor(config: ZoraActionProviderConfig) {
    super("zora", []);
    this.#privateKey = config.privateKey;
    
    // Validate private key and create account
    this.#account = privateKeyToAccount(this.#privateKey as Hex);
    if (!this.#account) throw new Error("Invalid private key");
    
    // Create public client
    this.#publicClient = createPublicClient({
      chain: base,
      transport: config.RPC_URL ? http(config.RPC_URL) : http(),
    }) as unknown as PublicClient;
    
    // Create wallet client
    this.#walletClient = createWalletClient({
      account: this.#account,
      chain: base,
      transport: http(),
    });
  }

  /**
   * Creates a new coin on the Zora protocol.
   *
   * @param walletProvider - The wallet provider to use for the transaction.
   * @param args - The input arguments for the action.
   * @returns A message containing the coin creation details.
   */
  @CreateAction({
    name: "createCoin",
    description: `
This tool will create a new coin on Zora protocol.
It takes the following parameters:
- name: The name of the coin
- symbol: The symbol of the coin
- uri: The metadata URI (IPFS URI recommended)
- payoutRecipient: The address that will receive creator earnings
- platformReferrer (optional): Optional platform referrer address that earns referral fees
- initialPurchaseWei (optional): Optional initial purchase amount in wei

The action will return the transaction hash, coin address, and deployment details upon success.
`,
    schema: CreateCoinSchema,
  })
  async createCoin(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof CreateCoinSchema>
  ): Promise<string> {
    try {
      // Validate that wallet matches the provider
      if (this.#account.address.toLowerCase() !== walletProvider.getAddress().toLowerCase()) {
        throw new Error("Private key does not match wallet provider address");
      }
      
      // Dynamically import Zora SDK to handle ESM/CommonJS compatibility
      const zoraModule = await import("@zoralabs/coins-sdk");
      
      // Create the coin using Zora SDK
      const result = await zoraModule.createCoin(
        {
          name: args.name,
          symbol: args.symbol,
          uri: args.uri,
          payoutRecipient: args.payoutRecipient as Hex || this.#account.address,
          platformReferrer: args.platformReferrer as Hex || "0x0000000000000000000000000000000000000000",
          initialPurchaseWei: args.initialPurchaseWei || 0n,
        },
        this.#walletClient,
        this.#publicClient
      );

      return `Successfully created coin:
- Transaction hash: ${result.hash}
- Coin address: ${result.address}
- Deployment details: ${JSON.stringify(result.deployment)}`;
    } catch (error) {
      return `Error creating coin: ${error}`;
    }
  }

  /**
   * Checks if the Zora action provider supports the given network.
   *
   * @param network - The network to check.
   * @returns True if the Zora action provider supports the network, false otherwise.
   */
  supportsNetwork = (network: Network) => 
    network.protocolFamily === "evm" && SUPPORTED_NETWORKS.includes(network.networkId!);
}

/**
 * Factory function to create a new ZoraActionProvider instance.
 *
 * @param config - Configuration options for the ZoraActionProvider
 * @returns A new ZoraActionProvider instance
 */
export const zoraActionProvider = (config: ZoraActionProviderConfig) =>
  new ZoraActionProvider(config); 