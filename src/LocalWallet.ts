import * as bitcoin from "bitcoinjs-lib";
import { isTaprootInput } from "bitcoinjs-lib/src/psbt/bip371";
import * as secp256k1 from "@bitcoinerlab/secp256k1";
import ECPairFactory, { ECPairInterface } from "ecpair";
import { AddressType } from "./OrdTransaction";
import { validator } from "./OrdTransaction";
import { OpenApiService } from "./open_api";
import { address as PsbtAddress } from "bitcoinjs-lib";
import { createSendBTC } from ".";
import { UTXO } from "./types";

const ECPair = ECPairFactory(secp256k1);
bitcoin.initEccLib(secp256k1);
interface BaseUserToSignInput {
  index: number;
  sighashTypes: number[] | undefined;
  disableTweakSigner?: boolean;
}

export interface AddressUserToSignInput extends BaseUserToSignInput {
  address: string;
}

export interface PublicKeyUserToSignInput extends BaseUserToSignInput {
  publicKey: string;
}

export type UserToSignInput = AddressUserToSignInput | PublicKeyUserToSignInput;

export interface SignPsbtOptions {
  autoFinalized: boolean;
  toSignInputs?: UserToSignInput[];
}
export const toXOnly = (pubKey: Buffer) =>
  pubKey.length === 32 ? pubKey : pubKey.slice(1, 33);

function tapTweakHash(pubKey: Buffer, h: Buffer | undefined): Buffer {
  return bitcoin.crypto.taggedHash(
    "TapTweak",
    Buffer.concat(h ? [pubKey, h] : [pubKey])
  );
}

function tweakSigner(signer: bitcoin.Signer, opts: any = {}): bitcoin.Signer {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  let privateKey: Uint8Array | undefined = signer.privateKey!;
  if (!privateKey) {
    throw new Error("Private key is required for tweaking signer!");
  }
  if (signer.publicKey[0] === 3) {
    privateKey = secp256k1.privateNegate(privateKey);
  }

  const tweakedPrivateKey = secp256k1.privateAdd(
    privateKey,
    tapTweakHash(toXOnly(signer.publicKey), opts.tweakHash)
  );
  if (!tweakedPrivateKey) {
    throw new Error("Invalid tweaked private key!");
  }

  return ECPair.fromPrivateKey(Buffer.from(tweakedPrivateKey), {
    network: opts.network,
  });
}
export enum NetworkType {
  MAINNET,
  TESTNET,
}
export function toPsbtNetwork(networkType: NetworkType) {
  if (networkType === NetworkType.MAINNET) {
    return bitcoin.networks.bitcoin;
  } else {
    return bitcoin.networks.testnet;
  }
}

export function publicKeyToPayment(
  publicKey: string,
  type: AddressType,
  networkType: NetworkType
) {
  const network = toPsbtNetwork(networkType);
  if (!publicKey) return null;
  const pubkey = Buffer.from(publicKey, "hex");
  if (type === AddressType.P2PKH) {
    return bitcoin.payments.p2pkh({
      pubkey,
      network,
    });
  } else if (type === AddressType.P2WPKH || type === AddressType.M44_P2WPKH) {
    return bitcoin.payments.p2wpkh({
      pubkey,
      network,
    });
  } else if (type === AddressType.P2TR || type === AddressType.M44_P2TR) {
    return bitcoin.payments.p2tr({
      internalPubkey: pubkey.slice(1, 33),
      network,
    });
  } else if (type === AddressType.P2SH_P2WPKH) {
    const data = bitcoin.payments.p2wpkh({
      pubkey,
      network,
    });
    return bitcoin.payments.p2sh({
      pubkey,
      network,
      redeem: data,
    });
  }
}

export function publicKeyToAddress(
  publicKey: string,
  type: AddressType,
  networkType: NetworkType
) {
  const payment = publicKeyToPayment(publicKey, type, networkType);
  if (payment && payment.address) {
    return payment.address;
  } else {
    return "";
  }
}

export function publicKeyToScriptPk(
  publicKey: string,
  type: AddressType,
  networkType: NetworkType
) {
  const payment = publicKeyToPayment(publicKey, type, networkType);
  return payment.output.toString("hex");
}

export interface ToSignInput {
  index: number;
  publicKey: string;
  sighashTypes?: number[];
}

export interface SignOptions {
  inputs?: ToSignInput[];
  autoFinalized?: boolean;
}

export function randomWIF(networkType = NetworkType.TESTNET) {
  const network = toPsbtNetwork(networkType);
  const keyPair = ECPair.makeRandom({ network });
  return keyPair.toWIF();
}

export class LocalWallet {
  keyPair: ECPairInterface;
  address: string;
  pubkey: string;
  addressType: AddressType;
  network: bitcoin.Network;
  constructor(
    wif: string,
    networkType: NetworkType = NetworkType.TESTNET,
    addressType: AddressType = AddressType.P2WPKH
  ) {
    const network = toPsbtNetwork(networkType);
    const keyPair = ECPair.fromWIF(wif, network);
    this.keyPair = keyPair;
    this.addressType = addressType;
    this.pubkey = keyPair.publicKey.toString("hex");
    this.address = publicKeyToAddress(this.pubkey, addressType, networkType);
    this.network = network;
    bitcoin.initEccLib(secp256k1);
  }

  signPsbt = async (
    psbt: bitcoin.Psbt,
    toSignInputs: ToSignInput[],
    autoFinalized: boolean
  ) => {
    if (!toSignInputs) {
      // Compatibility with legacy code.
      if (autoFinalized !== false) autoFinalized = true;
      toSignInputs = await this.formatOptionsToSignInputs(psbt, {
        autoFinalized,
      });
    }
    psbt.data.inputs.forEach((v, index) => {
      const isNotSigned = !(v.finalScriptSig || v.finalScriptWitness);
      const isP2TR =
        this.addressType === AddressType.P2TR ||
        this.addressType === AddressType.M44_P2TR;
      const lostInternalPubkey = !v.tapInternalKey;
      // Special measures taken for compatibility with certain applications.
      if (isNotSigned && isP2TR && lostInternalPubkey) {
        const tapInternalKey = toXOnly(Buffer.from(this.pubkey, "hex"));
        const { output } = bitcoin.payments.p2tr({
          internalPubkey: tapInternalKey,
          network: this.network,
        });
        if (v.witnessUtxo?.script.toString("hex") == output?.toString("hex")) {
          v.tapInternalKey = tapInternalKey;
        }
      }
    });

    psbt = await this.signTransaction(psbt, toSignInputs);
    if (autoFinalized) {
      toSignInputs.forEach((v) => {
        // psbt.validateSignaturesOfInput(v.index, validator);
        psbt.finalizeInput(v.index);
      });
    }
    return psbt;
  };
  formatOptionsToSignInputs = async (
    _psbt: string | bitcoin.Psbt,
    options?: SignPsbtOptions
  ) => {
    let toSignInputs: ToSignInput[] = [];
    if (options && options.toSignInputs) {
      // We expect userToSignInputs objects to be similar to ToSignInput interface,
      // but we allow address to be specified in addition to publicKey for convenience.
      toSignInputs = options.toSignInputs.map((input) => {
        const index = Number(input.index);
        if (isNaN(index)) throw new Error("invalid index in toSignInput");

        if (
          !(input as AddressUserToSignInput).address &&
          !(input as PublicKeyUserToSignInput).publicKey
        ) {
          throw new Error("no address or public key in toSignInput");
        }

        if (
          (input as AddressUserToSignInput).address &&
          (input as AddressUserToSignInput).address != this.address
        ) {
          throw new Error("invalid address in toSignInput");
        }

        if (
          (input as PublicKeyUserToSignInput).publicKey &&
          (input as PublicKeyUserToSignInput).publicKey != this.pubkey
        ) {
          throw new Error("invalid public key in toSignInput");
        }

        const sighashTypes = input.sighashTypes?.map(Number);
        if (sighashTypes?.some(isNaN))
          throw new Error("invalid sighash type in toSignInput");

        return {
          index,
          publicKey: this.pubkey,
          sighashTypes,
          disableTweakSigner: input.disableTweakSigner,
        };
      });
    } else {
      const psbt =
        typeof _psbt === "string"
          ? bitcoin.Psbt.fromHex(_psbt as string, { network: this.network })
          : (_psbt as bitcoin.Psbt);
      psbt.data.inputs.forEach((v, index) => {
        let script: any = null;
        let value = 0;
        if (v.witnessUtxo) {
          script = v.witnessUtxo.script;
          value = v.witnessUtxo.value;
        } else if (v.nonWitnessUtxo) {
          const tx = bitcoin.Transaction.fromBuffer(v.nonWitnessUtxo);
          const output = tx.outs[psbt.txInputs[index].index];
          script = output.script;
          value = output.value;
        }
        const isSigned = v.finalScriptSig || v.finalScriptWitness;
        if (script && !isSigned) {
          const address = PsbtAddress.fromOutputScript(script, this.network);
          if (this.address === address) {
            toSignInputs.push({
              index,
              publicKey: this.pubkey,
              sighashTypes: v.sighashType ? [v.sighashType] : undefined,
            });
          }
        }
      });
    }
    return toSignInputs;
  };
  getPublicKey() {
    return this.keyPair.publicKey.toString("hex");
  }

  async signTransaction(
    psbt: bitcoin.Psbt,
    inputs: { index: number; publicKey: string; sighashTypes?: number[] }[],
    opts?: any
  ) {
    inputs.forEach((input) => {
      if (isTaprootInput(psbt.data.inputs[input.index])) {
        const signer = tweakSigner(this.keyPair, opts);
        psbt.signInput(input.index, signer, input.sighashTypes);
      } else {
        const signer = this.keyPair;
        psbt.signInput(input.index, signer, input.sighashTypes);
      }
    });
    return psbt;
  }

  async pushPsbt(psbt: string) {
    const api = new OpenApiService(
      this.network === bitcoin.networks.bitcoin ? "bitcoin" : "bitcoin_testnet"
    );
    const result = await api.pushTx(psbt);
    return result;
  }

  sendBTC = async ({
    to,
    amount,
    utxos,
    receiverToPayFee,
    feeRate,
  }: {
    to: string;
    amount: number;
    utxos: UTXO[];
    receiverToPayFee: boolean;
    feeRate: number;
  }) => {
    const psbt = await createSendBTC({
      utxos: utxos.map((v) => {
        return {
          txId: v.txId,
          outputIndex: v.outputIndex,
          satoshis: v.satoshis,
          scriptPk: v.scriptPk,
          addressType: v.addressType,
          address: this.address,
          ords: v.inscriptions,
        };
      }),
      toAddress: to,
      toAmount: amount,
      wallet: this,
      network: this.network,
      changeAddress: this.address,
      receiverToPayFee,
      pubkey: this.pubkey,
      dump: true,
      feeRate,
    });
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    //@ts-ignore
    psbt.__CACHE.__UNSAFE_SIGN_NONSEGWIT = false;
    return psbt.toHex();
  };
}
