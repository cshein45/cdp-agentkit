import { z } from "zod";
import {
  parseUnits,
  Hex,
  createWalletClient,
  http,
  Chain,
  formatUnits,
  PublicClient,
  createPublicClient,
} from "viem";
import { ActionProvider } from "../actionProvider";
import { CHAIN_ID_TO_NETWORK_ID, Network, NETWORK_ID_TO_VIEM_CHAIN, getChain } from "../../network";
import { CreateAction } from "../actionDecorator";
import { BridgeTokenSchema, CheckDepositStatusSchema } from "./schemas";
import { EvmWalletProvider } from "../../wallet-providers";
import { isTestnet } from "./utils";
import { privateKeyToAccount } from "viem/accounts";
import { abi as ERC20_ABI } from "../erc20/constants";
/**
 * Configuration options for the SafeWalletProvider.
 */
export interface AcrossActionProviderConfig {
  /**
   * Private key of the signer that (co-)owns the Safe.
   */
  privateKey: string;
  /**
   * Network ID, for example "base-sepolia" or "ethereum-mainnet".
   */
  networkId?: string;
}

/**
 * AcrossActionProvider provides actions for cross-chain bridging via Across Protocol.
 */
export class AcrossActionProvider extends ActionProvider<EvmWalletProvider> {
  #privateKey: string;
  #chain: Chain;
  #publicClient: PublicClient;
  /**
   * Constructor for the AcrossActionProvider.
   *
   * @param config - The configuration options for the AcrossActionProvider.
   */
  constructor(config: AcrossActionProviderConfig) {
    super("across", []);
    this.#privateKey = config.privateKey;
    const account = privateKeyToAccount(this.#privateKey as Hex);
    if (!account) throw new Error("Invalid private key");

    this.#chain = NETWORK_ID_TO_VIEM_CHAIN[config.networkId || "base-sepolia"];
    if (!this.#chain) throw new Error(`Unsupported network: ${config.networkId}`);

    this.#publicClient = createPublicClient({
      chain: this.#chain,
      transport: http(),
    });
  }

  /**
   * Bridges a token from one chain to another using Across Protocol.
   *
   * @param walletProvider - The wallet provider to use for the transaction.
   * @param args - The input arguments for the action.
   * @returns A message containing the bridge details.
   */
  @CreateAction({
    name: "bridge_token",
    description: `
    This tool will bridge tokens from the current chain to another chain using the Across Protocol.
    Supports testnet to testnet (e.g. ethereum-sepolia to base-sepolia) or mainnet to mainnet (e.g. ethereum-mainnet to base-mainnet) bridging.

    It takes the following inputs:
    - destinationChainId: The chain ID of the destination chain (e.g. 84532 for base-sepolia, 1 for ethereum-mainnet)
    - inputTokenSymbol: The symbol of the token to bridge (e.g., 'ETH', 'USDC')
    - amount: The amount of tokens to bridge in whole units (e.g. 1.5 WETH, 10 USDC)
    - recipient: (Optional) The recipient address on the destination chain (defaults to sender)
    - maxSplippage: (Optional) The maximum slippage percentage (defaults to 1.5%)
    Important notes:
    - Origin chain is the currently connected chain of the wallet provider (e.g. base-sepolia, ethereum-mainnet)
    - Testnet deposits are not be refunded if not filled on destination chain
    - Ensure sufficient balance of the input token before bridging
    `,
    schema: BridgeTokenSchema,
  })
  async bridgeToken(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof BridgeTokenSchema>,
  ): Promise<string> {
    try {
      // Use dynamic import to get the Across SDK
      const acrossModule = await import("@across-protocol/app-sdk");
      const createAcrossClient = acrossModule.createAcrossClient;

      // Get recipient address if provided, otherwise use sender
      const recipient = (args.recipient || walletProvider.getAddress()) as Hex;

      // Get destination chain
      const destinationNetworkId = CHAIN_ID_TO_NETWORK_ID[Number(args.destinationChainId)];
      const destinationChain = NETWORK_ID_TO_VIEM_CHAIN[destinationNetworkId];
      if (!destinationChain) {
        throw new Error(`Unsupported destination chain: ${args.destinationChainId}`);
      }

      // Create wallet client
      const account = privateKeyToAccount(this.#privateKey as Hex);
      const walletClient = createWalletClient({
        account,
        chain: this.#chain,
        transport: http(),
      });

      // Create Across client
      const acrossClient = createAcrossClient({
        //integratorId: INTEGRATOR_ID,
        chains: [this.#chain, destinationChain],
        useTestnet: isTestnet(this.#chain.id),
      });

      // Get chain details to find token information
      const chainDetails = await acrossClient.getSupportedChains({});
      const originChainDetails = chainDetails.find(chain => chain.chainId === this.#chain.id);

      if (!originChainDetails) {
        throw new Error(`Origin chain ${this.#chain.id} not supported by Across Protocol`);
      }

      // Find token by symbol on the origin chain
      const inputTokens = originChainDetails.inputTokens;
      if (!inputTokens || inputTokens.length === 0) {
        throw new Error(`No input tokens available on chain ${this.#chain.id}`);
      }
      const tokenInfo = inputTokens.find(
        token => token.symbol.toUpperCase() === args.inputTokenSymbol.toUpperCase(),
      );
      if (!tokenInfo) {
        throw new Error(
          `Token ${args.inputTokenSymbol} not found on chain ${this.#chain.id}. Available tokens: ${inputTokens.map(t => t.symbol).join(", ")}`,
        );
      }

      // Get token address and decimals to parse the amount
      const inputToken = tokenInfo.address as Hex;
      const decimals = tokenInfo.decimals;
      const inputAmount = parseUnits(args.amount, decimals);

      // Check balance
      const isNative = args.inputTokenSymbol.toUpperCase() === "ETH";
      if (isNative) {
        // Check native ETH balance
        const ethBalance = await this.#publicClient.getBalance({
          address: account.address,
        });
        if (ethBalance < inputAmount) {
          throw new Error(
            `Insufficient balance. Requested to bridge ${formatUnits(inputAmount, decimals)} ${args.inputTokenSymbol} but balance is only ${formatUnits(ethBalance, decimals)} ${args.inputTokenSymbol}`,
          );
        }
      } else {
        // Check ERC20 token balance
        const tokenBalance = (await this.#publicClient.readContract({
          address: inputToken,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [account.address],
        })) as bigint;
        if (tokenBalance < inputAmount) {
          throw new Error(
            `Insufficient balance. Requested to bridge ${formatUnits(inputAmount, decimals)} ${args.inputTokenSymbol} but balance is only ${formatUnits(tokenBalance, decimals)} ${args.inputTokenSymbol}`,
          );
        }
      }

      // Get available routes
      const routeInfo = await acrossClient.getAvailableRoutes({
        originChainId: this.#chain.id,
        destinationChainId: destinationChain.id,
        originToken: inputToken,
      });

      // Select the appropriate route for native ETH or ERC20 token
      let route;
      for (let i = 0; i < routeInfo.length; i++) {
        if (routeInfo[i].isNative === isNative) {
          route = routeInfo[i];
          break;
        }
      }

      if (!route) {
        throw new Error(
          `No routes available from chain ${this.#chain.name} to chain ${destinationChain.name} for token ${args.inputTokenSymbol}`,
        );
      }

      // Get quote
      const quote = await acrossClient.getQuote({
        route,
        inputAmount: inputAmount,
        recipient,
      });

      // Convert units to readable format
      const formattedInfo = {
        minDeposit: formatUnits(quote.limits.minDeposit, decimals),
        maxDeposit: formatUnits(quote.limits.maxDeposit, decimals),
        inputAmount: formatUnits(quote.deposit.inputAmount, decimals),
        outputAmount: formatUnits(quote.deposit.outputAmount, decimals),
      };

      // Check if input amount is within valid deposit range
      if (quote.deposit.inputAmount < quote.limits.minDeposit) {
        throw new Error(
          `Input amount ${formattedInfo.inputAmount} ${args.inputTokenSymbol} is below the minimum deposit of ${formattedInfo.minDeposit} ${args.inputTokenSymbol}`,
        );
      }
      if (quote.deposit.inputAmount > quote.limits.maxDeposit) {
        throw new Error(
          `Input amount ${formattedInfo.inputAmount} ${args.inputTokenSymbol} exceeds the maximum deposit of ${formattedInfo.maxDeposit} ${args.inputTokenSymbol}`,
        );
      }

      // Check if output amount is within acceptable slippage limits
      const actualSlippagePercentage =
        ((Number(formattedInfo.inputAmount) - Number(formattedInfo.outputAmount)) /
          Number(formattedInfo.inputAmount)) *
        100;
      if (actualSlippagePercentage > args.maxSplippage) {
        throw new Error(
          `Output amount has high slippage of ${actualSlippagePercentage.toFixed(2)}%, which exceeds the maximum allowed slippage of ${args.maxSplippage}%. ` +
            `Input: ${formattedInfo.inputAmount} ${args.inputTokenSymbol}, Output: ${formattedInfo.outputAmount} ${args.inputTokenSymbol}`,
        );
      }

      //Approve ERC20 token if needed
      // let approvalTxHash;
      // if (!isNative) {
      //   const approvalAmount = quote.deposit.inputAmount;
      //   approvalTxHash = await walletClient.writeContract({
      //     address: inputToken,
      //     abi: ERC20_ABI,
      //     functionName: "approve",
      //     args: [quote.deposit.spokePoolAddress, approvalAmount],
      //   });
      //   await this.#publicClient.waitForTransactionReceipt({ hash: approvalTxHash });
      // }

      // // Simulate the deposit transaction
      // const { request } = await acrossClient.simulateDepositTx({
      //   walletClient: walletClient,
      //   deposit: quote.deposit,
      // });

      // // Execute the deposit transaction
      // const transactionHash = await walletClient.writeContract(request);

      // // Wait for tx to be mined
      // const { depositId } = await acrossClient.waitForDepositTx({
      //   transactionHash,
      //   originChainId: this.#chain.id,
      // });

      const destinationClient = createPublicClient({
        chain: destinationChain,
        transport: http(),
      });

      let approvalTxHash;
      let depositTxId;
      let depositTxHash;
      let fillTxHash;
      let success;
      const progress = await acrossClient.executeQuote({
        walletClient: walletClient,
        destinationClient: destinationClient,
        deposit: quote.deposit,
        onProgress: (progress) => {
          if (progress.step === "approve" && progress.status === "txSuccess") {
            const { txReceipt } = progress;
            approvalTxHash= txReceipt.transactionHash;
            console.log("approvalTxHash", approvalTxHash);
          }
          if (progress.step === "deposit" && progress.status === "txSuccess") {
            const { depositId, txReceipt } = progress;
            depositTxId = depositId;
            depositTxHash = txReceipt.transactionHash;
            console.log("depositTxId", depositTxId);
            console.log("depositTxHash", depositTxHash);
          }
          if (progress.step === "fill" && progress.status === "txSuccess") {
            const { fillTxTimestamp, txReceipt, actionSuccess } = progress;
            fillTxHash = txReceipt.transactionHash;
            success = actionSuccess;
            console.log("fillTxHash", fillTxHash);
          }
        },
        infiniteApproval: false,
        throwOnError: true,
      });

      return `
Successfully deposited tokens:
- From: Chain ${this.#chain.id} (${this.#chain.name})
- To: Chain ${destinationChain.id} (${destinationChain.name})
- Token: ${args.inputTokenSymbol} (${inputToken})
- Input Amount: ${formattedInfo.inputAmount} ${args.inputTokenSymbol}
- Output Amount: ${formattedInfo.outputAmount} ${args.inputTokenSymbol}
- Recipient: ${recipient}
${!isNative ? `- Transaction Hash for approval: ${approvalTxHash}\n` : ""}
- Transaction Hash for deposit: ${depositTxHash}
- Deposit ID: ${depositTxId}
- Transaction Hash for fill: ${fillTxHash}
- Success: ${success}
        `;
    } catch (error) {
      return `Error with Across SDK: ${error}`;
    }
  }

  /**
   * Checks the status of a bridge deposit via Across Protocol.
   *
   * @param walletProvider - The wallet provider to use for the transaction.
   * @param args - The input arguments for the action.
   * @returns A message containing the deposit status details.
   */
  @CreateAction({
    name: "check_deposit_status",
    description: `
    This tool will check the status of a cross-chain bridge deposit on the Across Protocol.
    
    It takes the following inputs:
    - originChainId: The chain ID of the origin chain (defaults to the current chain)
    - depositId: The ID of the deposit to check (returned by the bridge deposit transaction)
    `,
    schema: CheckDepositStatusSchema,
  })
  async checkDepositStatus(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof CheckDepositStatusSchema>,
  ): Promise<string> {
    const originChainId = Number(args.originChainId) || this.#chain.id;

    if (isTestnet(originChainId)) {
      throw new Error(
        "Checking deposit status on testnets is currently not supported by the Across API",
      );
    }

    try {
      const response = await fetch(
        `https://app.across.to/api/deposit/status?originChainId=${originChainId}&depositId=${args.depositId}`,
        {
          method: "GET",
        },
      );

      if (!response.ok) {
        throw new Error(`Across API request failed with status ${response.status}`);
      }

      const apiData = await response.json();

      // Get chain names
      const originChainName = getChain(String(apiData.originChainId))?.name || "Unknown Chain";
      const destinationChainName =
        getChain(String(apiData.destinationChainId))?.name || "Unknown Chain";

      // Create structured response
      const structuredResponse = {
        status: apiData.status || "unknown",
        depositTxInfo: apiData.depositTxHash
          ? {
              txHash: apiData.depositTxHash,
              chainId: apiData.originChainId,
              chainName: originChainName,
            }
          : null,
        fillTxInfo: apiData.fillTx
          ? {
              txHash: apiData.fillTx,
              chainId: apiData.destinationChainId,
              chainName: destinationChainName,
            }
          : null,
        depositRefundTxInfo: apiData.depositRefundTxHash
          ? {
              txHash: apiData.depositRefundTxHash,
              chainId: apiData.originChainId,
              chainName: originChainName,
            }
          : null,
      };

      return JSON.stringify(structuredResponse, null, 2);
    } catch (error) {
      return `Error checking deposit status: ${error}`;
    }
  }

  /**
   * Checks if the Across action provider supports the given network.
   *
   * @param network - The network to check.
   * @returns True if the Across action provider supports the network, false otherwise.
   */
  supportsNetwork = (network: Network) => {
    // Across only supports EVM-compatible chains
    return network.protocolFamily === "evm";
  };
}

export const acrossActionProvider = (config: AcrossActionProviderConfig) =>
  new AcrossActionProvider(config);
