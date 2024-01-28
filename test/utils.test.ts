import { expect } from "chai";
import { estimateInscribeFee } from "../src/utils";
import * as bitcoin from "bitcoinjs-lib";

it('estimate inscribe size', async () => {
    const size = await estimateInscribeFee({
        inscription: { 
        contentType: "text/plain;charset=utf-8",
        body: Buffer.from(
          `{"p": "brc-20","op": "transfer","tick": "bool","amt": "1000"}`
        ),},
        address: "tb1psahg2qmurajcnv6mjpws7aaefk9gnwp3xhn0x63v3n3pz8z9c2dspamp6v",
        network: bitcoin.networks.testnet,
        feeRate: 1
    })
    expect(size).equal(153)
})