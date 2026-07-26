import { screen } from '@testing-library/react';

/**
 * The zero-lists empty state is ONE state, keyed on `lists.length === 0` (v0.13, ADR 0064). This
 * asserts the state itself — the prompt AND a reachable way to create a list. Both arrival paths
 * (deleting the last list, and factory-reset-without-sample-data) call THIS SAME function, so "they
 * land on the same state, not two similar-looking ones" is proven by construction: one assertion,
 * both callers. The markers it checks only render at `lists.length === 0`, so it tests the condition,
 * not the appearance.
 *
 * ASYNC, deliberately: the "New list name" input appears via the deleted-list-reset EFFECT
 * (`listId → NEW_LIST`), which runs a tick AFTER `lists` empties. A synchronous query would race that
 * effect (it did — flaky ~40% before this). `findBy*` retries until the effect has run.
 */
export async function expectUsableEmptyState(): Promise<void> {
  await screen.findByText(/No lists yet/i);
  await screen.findByLabelText('New list name');
  await screen.findByLabelText('Task title');
}
