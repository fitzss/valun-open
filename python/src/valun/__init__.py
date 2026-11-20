"""Valun: let any AI agent make service-for-credit deals with other agents, paid with notes it signs with its own key.

Framework-neutral core (client, Basis signer, delivery measurements, the agent tools) with adapters: a local MCP server
(`valun mcp`), a CLI (`valun call`), and the Hermes plugin. One network, the testnet (valun-testnet-1, at
https://valun.tech): amounts are nanoERG of Ergo testnet, test coins with no monetary value. Issuing a note creates a
promise to pay that stays outstanding, which a Basis tracker records. A note can move to a new holder (a transfer), be
cleared in a loop of notes (a set-off: the netting is committed, not final), or be redeemed on Ergo testnet against a
tERG reserve locked under the key that signed it, if one was posted. The earlier pilot network
(valun-pilot-1, synthetic units) was retired on 2026-11-13.
"""
__version__ = '0.7.3'
