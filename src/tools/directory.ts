import { type Static, Type } from "typebox";
import { type AnyAgentTool, toToolResult } from "../agent-tool.js";
import type { SignalClient } from "../signal-client.js";

// Directory tools -- contacts and groups -- read live from signal-cli over the
// daemon socket (not from the SQLite store, which only holds messages). Both
// are structurally a flat list, but they're kept as two tools (not one
// `kind`-parameterized tool) because contacts and groups have genuinely
// different fields an agent reasons about, unlike ppl's near-identical
// taxonomy resources.

const listContactsParams = Type.Object({});

export function createListContactsTool(client: SignalClient): AnyAgentTool {
  return {
    name: "signal_list_contacts",
    label: "List Signal contacts",
    description:
      "List the Signal contacts known to this account (number, uuid, name/profile name). Use this " +
      "to resolve a person's name to the phone number that `signal_send_message` and " +
      "`signal_send_reaction` take as the recipient -- never guess a number.",
    parameters: listContactsParams,
    execute: async () => {
      const contacts = await client.listContacts();
      const shaped = contacts.map((c) => ({
        number: c.number ?? null,
        uuid: c.uuid ?? null,
        name: c.name ?? c.profileName ?? c.givenName ?? null,
        blocked: c.blocked ?? false,
      }));
      return toToolResult({ count: shaped.length, contacts: shaped });
    },
  };
}

const listGroupsParams = Type.Object({});

export function createListGroupsTool(client: SignalClient): AnyAgentTool {
  return {
    name: "signal_list_groups",
    label: "List Signal groups",
    description:
      "List the Signal groups this account is a member of (group id, name, member count). Use the " +
      "returned group id with `signal_send_message`/`signal_send_reaction`'s group_id argument to " +
      "act in a group instead of a 1:1 chat.",
    parameters: listGroupsParams,
    execute: async () => {
      const groups = await client.listGroups();
      const shaped = groups.map((g) => ({
        id: g.id ?? null,
        name: g.name ?? null,
        members: Array.isArray(g.members) ? g.members.length : 0,
        blocked: g.blocked ?? false,
      }));
      return toToolResult({ count: shaped.length, groups: shaped });
    },
  };
}

export type ListContactsParams = Static<typeof listContactsParams>;
export type ListGroupsParams = Static<typeof listGroupsParams>;
