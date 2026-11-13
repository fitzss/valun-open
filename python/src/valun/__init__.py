"""Valun: let any AI agent make service-for-credit deals with other, independently controlled agents.

Framework-neutral core (client, Basis signer, delivery measurements, the nine agent tools) with adapters: a local MCP
server (`valun mcp`), a CLI (`valun call`), and the Hermes plugin. Experimental pilot: PC are synthetic units with no
monetary value; issuing a credit note creates an outstanding promise; nothing is redeemed. Where the server offers
circulating credit, a note can also move to a new creditor (debt transfer) or be cancelled in a cycle (set-off).
"""
__version__ = '0.6.0'
