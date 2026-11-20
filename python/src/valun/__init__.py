"""Valun: let any AI agent make service-for-credit deals with other agents, paid with notes it signs with its own key.

Framework-neutral core (client, Basis signer, delivery measurements, the agent tools) with adapters: a local MCP server
(`valun mcp`), a CLI (`valun call`), and the Hermes plugin. One network, the testnet (valun-testnet-1, at
https://valun.tech): amounts are nanoERG of Ergo testnet, test coins with no monetary value. Issuing an IOU (a credit
note) creates an outstanding promise to pay, which a Basis tracker records. A note can move to a new creditor (debt
transfer), be cleared against an equal opposite debt in a loop (a set-off: the netting is committed, not final), or be
redeemed on Ergo testnet against its issuer's tERG reserve, if the issuer posted one. The earlier pilot network
(valun-pilot-1, synthetic units) was retired on 2026-11-13.
"""
__version__ = '0.7.2'
