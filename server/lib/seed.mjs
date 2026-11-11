// A small synthetic world so the first visit already shows every implemented state.
// All names, keys and amounts are invented; nothing here has monetary value.
// Resumable: every step checks whether it already happened, so an interrupted seed (e.g. a restart during the
// first boot) is completed on the next start instead of leaving a half-built world. `seededAt` marks completion.
const ERG = 1_000_000_000n;
const nano = erg => (BigInt(Math.round(erg * 1000)) * ERG / 1000n).toString();

export async function seed(valun) {
  const st = valun.store.state;
  if (st.seededAt) return false;
  const person = async (name, kind, about) => Object.values(st.participants).find(p => p.name === name)
    ?? valun.createParticipant({name, kind, about});
  const offer = async (issuer, recipient, erg, purpose, dueDays) => Object.values(st.offers).find(o =>
    o.issuerId === issuer.id && o.recipientId === recipient.id && o.terms.purpose === purpose)
    ?? valun.createOffer({issuerId: issuer.id, recipientId: recipient.id, amount: nano(erg), purpose,
      dueAt: dueDays == null ? null : new Date(Date.now() + dueDays * 864e5).toISOString()});
  const accept = async (o, by, reason) => { if (valun.offer(o.id).status === 'offered') await valun.decide(o.id, {actorId: by.id, decision: 'accept', reason}); };

  const atlas = await person('Atlas', 'agent', 'Data-cleaning agent (synthetic)');
  const bramble = await person('Bramble', 'agent', 'Compute broker agent (synthetic)');
  const cora = await person('Cora', 'operator', 'Human operator who reviews agent output (synthetic)');
  const dune = await person('Dune', 'agent', 'Routing agent, new to this group (synthetic)');

  // 1. Atlas buys compute from Bramble on credit: offered -> accepted -> issued in the real tracker.
  await accept(await offer(atlas, bramble, 2, 'GPU hours for a dataset-cleaning run', 7), bramble, 'Atlas is a known counterparty');
  // 2. Cora publishes a real Basis acceptance policy: trusts Atlas and Bramble, up to 5 ERG each.
  if (!cora.policy) await valun.setPolicy(cora.id, {mode: 'whitelist', trustedIds: [atlas.id, bramble.id], maxDebt: nano(5)});
  // 3. Bramble, now holding a claim on Atlas, pays Cora with its own note (circulation by re-issuance). Left open.
  await offer(bramble, cora, 1.5, 'Review of the cleaning output', 3);
  // 4. Dune is not in Cora's policy: the Basis check will say no. Left open for Cora to decide.
  await offer(dune, cora, 0.5, 'Route lookup credits');
  // 5. An overdue obligation: Atlas owes Dune, due date already passed.
  await accept(await offer(atlas, dune, 0.25, 'Routing for last week\'s batch', -1), dune);

  st.seededAt = new Date().toISOString();
  valun.store.save();
  return true;
}
