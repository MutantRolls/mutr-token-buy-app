// pages/index.tsx
import { useState, useEffect } from 'react';
import { PublicKey, Connection, Transaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddress, createTransferInstruction, getAccount } from '@solana/spl-token';
import { Coins, DollarSign, ArrowRight, Loader2, Check } from 'lucide-react';
import { toast } from 'react-toastify';
import bs58 from 'bs58';

// Devnet USDC mint (Circle's official devnet USDC)
const USDC_MINT = new PublicKey(process.env.NEXT_PUBLIC_USDC_MINT!);
const RECEIVER_WALLET = new PublicKey(process.env.NEXT_PUBLIC_RECEIVER_WALLET!);
const MUTR_EXCHANGE_RATE_SOL = 380000; // 1 SOL = 380,000 MUTR
const MUTR_EXCHANGE_RATE_USDC = 5000;  // 1 USDC = 5,000 MUTR

// Add Phantom wallet type
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

const LIMITS = {
  SOL:  { min: 0.01, max: 100,   decimals: 4 },
  USDC: { min: 1,    max: 10000, decimals: 2 },
} as const;

function validate(value: string, token: 'SOL' | 'USDC'): string {
  if (!value) return '';
  const num = parseFloat(value);
  if (isNaN(num)) return 'Enter a valid number';
  const { min, max, decimals } = LIMITS[token];
  if (num <= 0) return 'Amount must be greater than 0';
  if (num < min) return `Minimum is ${min} ${token}`;
  if (num > max) return `Maximum is ${max.toLocaleString()} ${token}`;
  const decimalPart = value.split('.')[1];
  if (decimalPart && decimalPart.length > decimals)
    return `Max ${decimals} decimal places for ${token}`;
  return '';
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
  const [mutrSignature, setMutrSignature] = useState<string>('');
  const [validationError, setValidationError] = useState<string>('');

  // Calculate MUTR token output (no trailing .00)
  useEffect(() => {
    if (inputAmount && !isNaN(parseFloat(inputAmount))) {
      const amount = parseFloat(inputAmount);
      const rate = paymentToken === 'SOL' ? MUTR_EXCHANGE_RATE_SOL : MUTR_EXCHANGE_RATE_USDC;
      const value = amount * rate;
      const str = value % 1 === 0 ? String(Math.round(value)) : String(parseFloat(value.toFixed(2)));
      setOutputAmount(str);
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
    
    if (typeof window !== 'undefined') {
      checkWalletConnection();
    }
  }, []);

  // Connect wallet
  const connectWallet = async () => {
    try {
      const isPhantomInstalled = window.phantom?.solana?.isPhantom;
      
      if (!isPhantomInstalled) {
        window.open('https://phantom.app/', '_blank');
        return;
      }
      
      const response = await window.phantom!.solana!.connect();
      setPublicKey(response.publicKey);
      setWalletConnected(true);

    } catch (error) {
      console.error('Error connecting to wallet:', error);
      toast.error('Failed to connect wallet. Please try again.');
    }
  };

  // Disconnect wallet
  const disconnectWallet = async () => {
    try {
      await window.phantom?.solana?.disconnect();
      setPublicKey(null);
      setWalletConnected(false);
      setStatus('');
      setIsSuccess(false);
      setTxSignature('');
      setMutrSignature('');
    } catch (error) {
      console.error('Error disconnecting wallet:', error);
    }
  };

  const fulfillMutr = async (paymentSignature: string, token: 'SOL' | 'USDC', amount: string) => {
    setStatus('Sending MUTR tokens to your wallet...');
    const res = await fetch('/api/fulfill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paymentSignature,
        buyerPublicKey: publicKey!.toString(),
        paymentToken: token,
        inputAmount: amount,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Failed to send MUTR tokens');
    return data as { mutrSignature: string; mutrAmount: number };
  };

  // Send SOL
  const sendSol = async () => {
    if (!publicKey || !inputAmount || isNaN(parseFloat(inputAmount))) return;

    try {
      setIsLoading(true);
      setIsSuccess(false);
      setStatus('Preparing transaction...');

      const connection = new Connection(process.env.NEXT_PUBLIC_SOLANA_RPC!, 'confirmed');

      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: RECEIVER_WALLET,
          lamports: parseFloat(inputAmount) * LAMPORTS_PER_SOL,
        })
      );

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = publicKey;

      setStatus('Please approve the transaction in your wallet...');
      const signedTransaction = await window.phantom!.solana!.signTransaction(transaction);

      // Extract signature from signed tx before sending so we have it even if already processed
      const signature = bs58.encode(signedTransaction.signatures[0].signature!);

      setStatus('Sending SOL...');
      try {
        await connection.sendRawTransaction(signedTransaction.serialize());
      } catch (sendError: any) {
        if (!sendError.message?.includes('already been processed')) throw sendError;
      }

      setStatus('Confirming payment...');
      await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
      setTxSignature(signature);

      const { mutrSignature, mutrAmount } = await fulfillMutr(signature, 'SOL', inputAmount);

      setMutrSignature(mutrSignature);
      setStatus(`Success! ${mutrAmount.toLocaleString()} MUTR sent to your wallet.`);
      setIsSuccess(true);
      setIsLoading(false);
      setTimeout(() => setInputAmount(''), 5000);

    } catch (error: any) {
      console.error('Error sending SOL:', error);
      const msg = error.message ?? 'Transaction failed';
      setStatus(msg);
      toast.error(msg);
      setIsLoading(false);
    }
  };

  // Send USDC
  const sendUsdc = async () => {
    if (!publicKey || !inputAmount || isNaN(parseFloat(inputAmount))) return;

    try {
      setIsLoading(true);
      setIsSuccess(false);
      setStatus('Preparing transaction...');

      const connection = new Connection(process.env.NEXT_PUBLIC_SOLANA_RPC!, 'confirmed');

      const senderTokenAccount = await getAssociatedTokenAddress(USDC_MINT, publicKey);
      const receiverTokenAccount = await getAssociatedTokenAddress(USDC_MINT, RECEIVER_WALLET);

      try {
        await getAccount(connection, senderTokenAccount);
      } catch {
        throw new Error("You don't have a USDC token account. Add USDC to your wallet first.");
      }

      const transaction = new Transaction();
      const tokenAmount = Math.floor(parseFloat(inputAmount) * 1_000_000);

      transaction.add(
        createTransferInstruction(senderTokenAccount, receiverTokenAccount, publicKey, tokenAmount)
      );

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = publicKey;

      setStatus('Please approve the transaction in your wallet...');
      const signedTransaction = await window.phantom!.solana!.signTransaction(transaction);

      // Extract signature from signed tx before sending so we have it even if already processed
      const signature = bs58.encode(signedTransaction.signatures[0].signature!);

      setStatus('Sending USDC...');
      try {
        await connection.sendRawTransaction(signedTransaction.serialize());
      } catch (sendError: any) {
        if (!sendError.message?.includes('already been processed')) throw sendError;
      }

      setStatus('Confirming payment...');
      await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
      setTxSignature(signature);

      const { mutrSignature, mutrAmount } = await fulfillMutr(signature, 'USDC', inputAmount);

      setMutrSignature(mutrSignature);
      setStatus(`Success! ${mutrAmount.toLocaleString()} MUTR sent to your wallet.`);
      setIsSuccess(true);
      setIsLoading(false);
      setTimeout(() => setInputAmount(''), 5000);

    } catch (error: any) {
      console.error('Error sending USDC:', error);
      const msg = error.message ?? 'Transaction failed';
      setStatus(msg);
      toast.error(msg);
      setIsLoading(false);
    }
  };

  // Handle purchase
  const handlePurchase = async () => {
    if (paymentToken === 'SOL') {
      await sendSol();
    } else {
      await sendUsdc();
    }
  };

  // Shorten address for mobile: first 4 + ... + last 4
  const shortAddress = publicKey
    ? `${publicKey.toString().slice(0, 4)}…${publicKey.toString().slice(-4)}`
    : '';

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col items-center mut-bg px-3 sm:px-4 pt-2 sm:pt-3 pb-4 sm:pb-6">
      
      {/* Connected Wallet bar – top, near window close area */}
      {walletConnected && (
        <div className="w-full max-w-md flex justify-end items-center gap-2 px-1 pb-2 sm:pb-3">
          <div className="mut-wallet-compact flex items-center gap-2 min-w-0 flex-1 sm:flex-initial justify-end">
            <span className="text-[10px] sm:text-xs text-gray-300 shrink-0 hidden sm:inline">Wallet</span>
            <span className="mut-wallet-inline text-[10px] sm:text-xs truncate max-w-[140px] sm:max-w-[200px]" title={publicKey?.toString()}>
              {shortAddress}
            </span>
            <button
              onClick={disconnectWallet}
              className="text-[10px] sm:text-xs text-red-400 hover:text-red-300 shrink-0 whitespace-nowrap"
            >
              Disconnect
            </button>
          </div>
        </div>
      )}
      
      <div className="rounded-lg p-4 sm:p-6 w-full max-w-md mx-auto flex-1 flex flex-col">
        <h1 className="text-lg sm:text-xl md:text-2xl font-bold mb-4 sm:mb-6 text-center">Buy MUTR Token</h1>
        
        {!walletConnected && (
          <div className="mb-4 sm:mb-6">
            <button
              onClick={connectWallet}
              className="w-full py-3 text-white font-medium flex items-center justify-center gap-2 mut-btn text-xs sm:text-sm"
            />
          </div>
        )}
        
        {walletConnected && (
          <>
            {/* Token Selection */}
            <div className="mb-4 sm:mb-6">
              <label className="block text-xs sm:text-sm font-medium mb-2 text-center">Select Payment Token</label>
              <div className="flex gap-2">
                <button 
                  className={`flex-1 py-2.5 sm:py-3 px-3 sm:px-4 flex items-center justify-center gap-1.5 sm:gap-2 text-xs sm:text-base ${paymentToken === 'SOL' ? 'bg-blue-600 ' : 'bg-gray-800 text-gray-100'}`}
                  onClick={() => { setPaymentToken('SOL'); setValidationError(validate(inputAmount, 'SOL')); }}
                  disabled={isLoading}
                >
                  <Coins className="w-4 h-4 sm:w-5 sm:h-5" />
                  <span>SOL</span>
                </button>
                <button 
                  className={`flex-1 py-2.5 sm:py-3 px-3 sm:px-4 flex items-center justify-center gap-1.5 sm:gap-2 text-xs sm:text-base ${paymentToken === 'USDC' ? 'bg-blue-600 ' : 'bg-gray-800 text-gray-100'}`}
                  onClick={() => { setPaymentToken('USDC'); setValidationError(validate(inputAmount, 'USDC')); }}
                  disabled={isLoading}
                >
                  <DollarSign className="w-4 h-4 sm:w-5 sm:h-5" />
                  <span>USDC</span>
                </button>
              </div>
            </div>
            
            {/* Input Amount */}
            <div className="mb-4 sm:mb-6">
              <label className="block text-xs sm:text-sm font-medium mb-2 text-center">Enter Amount</label>
              <div className="relative">
                <input
                  type="number"
                  className={`w-full p-2.5 sm:p-3 text-sm sm:text-base text-black border focus:ring-blue-500 focus:border-blue-500 ${validationError ? 'border-red-500' : 'border-gray-300'}`}
                  placeholder={`Enter ${paymentToken} amount`}
                  value={inputAmount}
                  onChange={(e) => {
                    setInputAmount(e.target.value);
                    setValidationError(validate(e.target.value, paymentToken));
                  }}
                  min="0"
                  step={paymentToken === 'SOL' ? '0.0001' : '0.01'}
                  disabled={isLoading}
                />
                <div className="absolute right-2.5 sm:right-3 top-2.5 sm:top-3 text-gray-500 font-semibold text-xs sm:text-sm">
                  {paymentToken}
                </div>
              </div>
              {validationError && (
                <p className="mt-1.5 text-[10px] sm:text-xs text-red-400">{validationError}</p>
              )}
              {!validationError && (
                <p className="mt-1.5 text-[10px] sm:text-xs text-gray-400 text-center">
                  Min {LIMITS[paymentToken].min} · Max {LIMITS[paymentToken].max.toLocaleString()} {paymentToken}
                </p>
              )}
            </div>
            
            {/* Exchange Calculation */}
            <div className="p-3 sm:p-4 rounded-md mb-4 sm:mb-6">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs sm:text-sm">You Pay</p>
                  <p className="text-sm sm:text-lg font-bold mut-y truncate">
                    {inputAmount || '0'} {paymentToken}
                  </p>
                </div>
                <ArrowRight className="w-4 h-4 sm:w-5 sm:h-5 shrink-0 text-gray-100" />
                <div className="min-w-0 text-right">
                  <p className="text-xs sm:text-sm">You Receive</p>
                  <p className="text-sm sm:text-lg font-bold mut-g truncate">{outputAmount} MUTR</p>
                </div>
              </div>
              <p className="text-[10px] sm:text-xs mt-2 text-center">
                Rate: 1 {paymentToken} = {paymentToken === 'SOL' ? MUTR_EXCHANGE_RATE_SOL : MUTR_EXCHANGE_RATE_USDC} MUTR
              </p>
            </div>
            
            {/* Transaction Status */}
            {status && (
              <div className={`mb-4 sm:mb-6 p-2.5 sm:p-3 rounded-md text-center ${isSuccess ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>
                <div className="flex items-center justify-center gap-1.5 sm:gap-2 flex-wrap">
                  {isLoading ? (
                    <Loader2 className="w-4 h-4 sm:w-5 sm:h-5 animate-spin shrink-0" />
                  ) : isSuccess ? (
                    <Check className="w-4 h-4 sm:w-5 sm:h-5 shrink-0" />
                  ) : null}
                  <span className="text-xs sm:text-sm">{status}</span>
                </div>
                {txSignature && (
                  <a
                    href={`https://explorer.solana.com/tx/${txSignature}?cluster=devnet`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] sm:text-xs underline mt-2 inline-block break-all"
                  >
                    Payment tx ↗
                  </a>
                )}
                {mutrSignature && (
                  <a
                    href={`https://explorer.solana.com/tx/${mutrSignature}?cluster=devnet`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] sm:text-xs underline mt-1 inline-block break-all"
                  >
                    MUTR transfer tx ↗
                  </a>
                )}
              </div>
            )}
            
            {/* Purchase Button */}
            <button
              className={`mut-buy-green w-full py-2.5 sm:py-3 text-white rounded-md font-medium flex items-center justify-center gap-1.5 sm:gap-2 text-xs sm:text-sm ${isLoading ? 'bg-gray-500 cursor-not-allowed' : 'bg-green-600 hover:bg-green-700'}`}
              onClick={handlePurchase}
              disabled={isLoading || !inputAmount || !!validationError || isNaN(parseFloat(inputAmount)) || parseFloat(inputAmount) <= 0}
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-4 h-4 sm:w-5 sm:h-5 animate-spin" />
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
