// C-33 (FR-3): pure approval rule for paying. `actions` are the claim's history actions in seq order.
export function approvalsComplete(actions: string[]): boolean {
  const cycle = actions.slice(Math.max(actions.lastIndexOf('submit'), actions.lastIndexOf('resubmit')) + 1);
  return cycle.includes('approve_final') || cycle.includes('approve_second');
}
