// C-33 (FR-3): pure approval rule for paying. `actions` are the claim's history actions in seq order.
export const cycleStart = (actions: string[]): number => Math.max(actions.lastIndexOf('submit'), actions.lastIndexOf('resubmit')) + 1;

export function approvalsComplete(actions: string[]): boolean {
  const cycle = actions.slice(cycleStart(actions));
  return cycle.includes('approve_final') || cycle.includes('approve_second');
}
