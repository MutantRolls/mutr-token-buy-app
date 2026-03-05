// pages/index.tsx
import { useState, useEffect } from 'react';
import {
  PublicKey,
  Connection,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { getAssociatedTokenAddress, createTransferInstruction } from '@solana/spl-token';
import { Coins, DollarSign, ArrowRight, Loader2, Check, Wallet } from 'lucide-react';
import Head from 'next/head';

// NOTE: This is MAINNET USDC mint (not devnet)
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const RECEIVER_WALLET = new PublicKey('HQ14VLzczC4UR1HRpVKgqzFp9jZNZigADCNbiKxH6t3q');

// Exchange rates (keep your intended values)
const MUTR_EXCHANGE_RATE_SOL = 380000; // 1 SOL = 380,000 MUTR
const MUTR_EXCHANGE_RATE_USDC = 5000;  // 1 USDC = 5,000 MUTR

declare global {
  interface Window {
    phantom?: {
      solana?: {
        isPhantom: boolean;
        isConnected: boolean;
        publicKey: PublicKey;
        connect: () => Promise<{ publicKey: PublicKey }>;
        disconnect: () => Promise<void>;
        signTransaction: (transaction: Transaction) => Promise<Transaction>;
      };
    };
  }
}

export default function DepositApp() {
  const [walletConnected, setWalletConnected] = useState<boolean>(false);
  const [publicKey, setPublicKey] = useState<PublicKey | null>(null);
  const [paymentToken, setPaymentToken] = useState<'SOL' | 'USDC'>('SOL');
  const [inputAmount, setInputAmount] = useState<string>('');
  const [outputAmount, setOutputAmount] = useState<string>('0');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [status, setStatus] = useState<string>('');
  const [isSuccess, setIsSuccess] = useState<boolean>(false);
  const [txSignature, setTxSignature] = useState<string>('');

  // Calculate MUTR token output
  useEffect(() => {
    if (inputAmount && !isNaN(parseFloat(inputAmount))) {
      const amount = parseFloat(inputAmount);
      const rate = paymentToken === 'SOL' ? MUTR_EXCHANGE_RATE_SOL : MUTR_EXCHANGE_RATE_USDC;
      setOutputAmount((amount * rate).toFixed(2));
    } else {
      setOutputAmount('0');
    }
  }, [inputAmount, paymentToken]);

  // Check wallet connection
  useEffect(() => {
    const checkWalletConnection = async () => {
      try {
        const isPhantomInstalled = window.phantom?.solana?.isPhantom;

        if (isPhantomInstalled && window.phantom?.solana?.isConnected) {
          const phPublicKey = window.phantom?.solana?.publicKey;
          if (phPublicKey) {
            setPublicKey(phPublicKey);
            setWalletConnected(true);
          }
        }
      } catch (error) {
        console.error('Error checking wallet connection:', error);
      }
    };

    if (typeof window !== 'undefined') checkWalletConnection();
  }, []);

  const connectWallet = async () => {
    try {
      const isPhantomInstalled = window.phantom?.solana?.isPhantom;

      if (!isPhantomInstalled) {
        window.open('https://phantom.app/', '_blank');
        return;
      }

      const response: any = await window.phantom?.solana?.connect();
      setPublicKey(response.publicKey);
      setWalletConnected(true);
    } catch (error) {
      console.error('Error connecting to wallet:', error);
      setStatus('Failed to connect wallet');
    }
  };

  const disconnectWallet = async () => {
    try {
      await window.phantom?.solana?.disconnect();
      setPublicKey(null);
      setWalletConnected(false);
      setStatus('');
      setIsSuccess(false);
      setTxSignature('');
      setInputAmount('');
    } catch (error) {
      console.error('Error disconnecting wallet:', error);
    }
  };

  // Send SOL
  const sendSol = async () => {
    if (!publicKey || !inputAmount || isNaN(parseFloat(inputAmount))) return;

    try {
      setIsLoading(true);
      setIsSuccess(false);
      setTxSignature('');
      setStatus('Preparing transaction...');

      const connection = new Connection(
        'https://mainnet.helius-rpc.com/?api-key=e108c043-8e40-4031-a4f5-e73249bc3cbc',
        'confirmed'
      );

      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: RECEIVER_WALLET,
          lamports: Math.round(parseFloat(inputAmount) * LAMPORTS_PER_SOL),
        })
      );

      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = publicKey;

      setStatus('Please approve the transaction in your wallet...');
      const signedTransaction: any = await window.phantom?.solana?.signTransaction(transaction);

      setStatus('Sending SOL...');
      const signature = await connection.sendRawTransaction(signedTransaction.serialize());

      setStatus('Confirming transaction...');
      await connection.confirmTransaction(signature, 'confirmed');

      setStatus(`Transaction successful! ${inputAmount} SOL sent.`);
      setIsSuccess(true);
      setTxSignature(signature);

      setTimeout(() => {
        setInputAmount('');
        setIsLoading(false);
      }, 2000);
    } catch (error: any) {
      console.error('Error sending SOL:', error);
      setStatus(`Transaction failed: ${error?.message || 'Unknown error'}`);
      setIsLoading(false);
    }
  };

  // Send USDC
  const sendUsdc = async () => {
    if (!publicKey || !inputAmount || isNaN(parseFloat(inputAmount))) return;

    try {
      setIsLoading(true);
      setIsSuccess(false);
      setTxSignature('');
      setStatus('Preparing transaction...');

      const connection = new Connection(
        'https://mainnet.helius-rpc.com/?api-key=e108c043-8e40-4031-a4f5-e73249bc3cbc',
        'confirmed'
      );

      const senderTokenAccount = await getAssociatedTokenAddress(USDC_MINT, publicKey);
      const receiverTokenAccount = await getAssociatedTokenAddress(USDC_MINT, RECEIVER_WALLET);

      const transaction = new Transaction();
      const tokenAmount = Math.floor(parseFloat(inputAmount) * 1_000_000); // USDC 6 decimals

      transaction.add(
        createTransferInstruction(senderTokenAccount, receiverTokenAccount, publicKey, tokenAmount)
      );

      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = publicKey;

      setStatus('Please approve the transaction in your wallet...');
      const signedTransaction: any = await window.phantom?.solana?.signTransaction(transaction);

      setStatus('Sending USDC...');
      const signature = await connection.sendRawTransaction(signedTransaction.serialize());

      setStatus('Confirming transaction...');
      await connection.confirmTransaction(signature, 'confirmed');

      setStatus(`Transaction successful! ${inputAmount} USDC sent.`);
      setIsSuccess(true);
      setTxSignature(signature);

      setTimeout(() => {
        setInputAmount('');
        setIsLoading(false);
      }, 2000);
    } catch (error: any) {
      console.error('Error sending USDC:', error);
      setStatus(`Transaction failed: ${error?.message || 'Unknown error'}`);
      setIsLoading(false);
    }
  };

  const handlePurchase = async () => {
    if (paymentToken === 'SOL') await sendSol();
    else await sendUsdc();
  };

  return (
    <div className="min-h-screen overflow-x-hidden bg-gray-100 flex items-center justify-center mut-bg px-3 py-6">
      <Head>
        <title>MUTR Token Purchase</title>
        <meta name="description" content="Buy MUTR tokens with SOL or USDC" />
        <link rel="icon" href="/favicon.ico" />
      </Head>

      {/* Mobile-safe card: no horizontal scrolling, nice borders, fits screen */}
      <div className="w-full max-w-md max-h-[90vh] overflow-y-auto overflow-x-hidden rounded-xl border border-white/10 shadow-xl backdrop-blur-sm bg-black/40 p-4">
        {/* Wallet Connection */}
        <div className="mb-4">
          {!walletConnected ? (
            <button
              onClick={connectWallet}
              className="w-full py-3 text-white font-medium flex items-center justify-center gap-2 mut-btn rounded-lg"
            >
              <Wallet size={18} />
              <span>Connect Phantom</span>
            </button>
          ) : (
            <div className="p-3 rounded-lg border border-white/10 bg-black/20">
              <div className="flex items-center justify-between gap-3 mut-adress">
                <div className="min-w-0">
                  <span className="text-sm">Connected Wallet</span>
                  <p className="text-sm truncate mut-wallet">{publicKey?.toString()}</p>
                </div>
                <button
                  onClick={disconnectWallet}
                  className="text-sm text-red-500 hover:text-red-400 shrink-0"
                >
                  Disconnect
                </button>
              </div>
            </div>
          )}
        </div>

        {walletConnected && (
          <>
            {/* Token Selection */}
            <div className="mb-4">
              <label className="block text-sm font-medium mb-2 text-center">
                Select Payment Token
              </label>

              <div className="grid grid-cols-2 gap-2">
                <button
                  className={`rounded-lg py-3 px-4 flex items-center justify-center gap-2 ${
                    paymentToken === 'SOL' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-100'
                  }`}
                  onClick={() => setPaymentToken('SOL')}
                  disabled={isLoading}
                >
                  <Coins size={20} />
                  <span>SOL</span>
                </button>

                <button
                  className={`rounded-lg py-3 px-4 flex items-center justify-center gap-2 ${
                    paymentToken === 'USDC' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-100'
                  }`}
                  onClick={() => setPaymentToken('USDC')}
                  disabled={isLoading}
                >
                  <DollarSign size={20} />
                  <span>USDC</span>
                </button>
              </div>
            </div>

            {/* Input Amount */}
            <div className="mb-4">
              <label className="block text-sm font-medium mb-2 text-center">Enter Amount</label>
              <div className="relative">
                <input
                  type="number"
                  className="w-full rounded-lg p-3 pr-16 text-black border border-gray-300 focus:ring-blue-500 focus:border-blue-500"
                  placeholder={`Enter ${paymentToken} amount`}
                  value={inputAmount}
                  onChange={(e) => setInputAmount(e.target.value)}
                  min="0"
                  step="0.01"
                  disabled={isLoading}
                />
                <div className="absolute right-3 top-3 text-gray-600 font-semibold">
                  {paymentToken}
                </div>
              </div>
            </div>

            {/* Exchange Calculation */}
            <div className="p-4 rounded-lg border border-white/10 bg-black/20 mb-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-white/80">You Pay</p>
                  <p className="text-lg font-bold mut-y">
                    {inputAmount || '0'} {paymentToken}
                  </p>
                </div>

                <ArrowRight className="text-white/70 shrink-0" />

                <div className="min-w-0 text-right">
                  <p className="text-sm text-white/80">You Receive</p>
                  <p className="text-lg font-bold mut-g truncate">{outputAmount} MUTR</p>
                </div>
              </div>

              <p className="text-xs mt-2 text-center text-white/70">
                Rate: 1 {paymentToken} ={' '}
                {paymentToken === 'SOL' ? MUTR_EXCHANGE_RATE_SOL : MUTR_EXCHANGE_RATE_USDC} MUTR
              </p>
            </div>

            {/* Transaction Status */}
            {status && (
              <div
                className={`mb-4 p-3 rounded-lg text-center border ${
                  isSuccess
                    ? 'bg-green-100 text-green-700 border-green-200'
                    : 'bg-blue-100 text-blue-700 border-blue-200'
                }`}
              >
                <div className="flex items-center justify-center gap-2">
                  {isLoading ? (
                    <Loader2 size={20} className="animate-spin" />
                  ) : isSuccess ? (
                    <Check size={20} />
                  ) : null}
                  <span className="text-sm">{status}</span>
                </div>

                {txSignature && (
                  <a
                    href={`https://explorer.solana.com/tx/${txSignature}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs underline mt-2 inline-block break-all"
                  >
                    View on Solana Explorer
                  </a>
                )}
              </div>
            )}

            {/* Purchase Button */}
            <button
              className={`w-full py-3 text-white rounded-lg font-medium flex items-center justify-center gap-2 mut-buy-green ${
                isLoading ? 'bg-gray-500 cursor-not-allowed' : 'bg-green-600 hover:bg-green-700'
              }`}
              onClick={handlePurchase}
              disabled={
                isLoading ||
                !inputAmount ||
                isNaN(parseFloat(inputAmount)) ||
                parseFloat(inputAmount) <= 0
              }
            >
              {isLoading ? (
                <>
                  <Loader2 size={20} className="animate-spin" />
                  <span>Processing...</span>
                </>
              ) : (
                <span>Buy MUTR Tokens</span>
              )}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
