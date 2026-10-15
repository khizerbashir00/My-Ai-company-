import { AGENTS } from './agent-catalog';
import { PERMISSIONS, TOOLS, isPermissionKey, isToolName, toolsMissingPermissions } from './registry';

describe('agent registry', () => {
  it('exposes no shell, filesystem or SQL tools', () => {
    const names = Object.keys(TOOLS).join(' ');
    expect(names).not.toMatch(/shell|exec|bash|sql|file_write|filesystem|eval/i);
  });

  it('marks every externally visible or financial action as approval-locked', () => {
    for (const key of ['outreach.send', 'content.publish', 'campaigns.launch_paid', 'files.share_sensitive', 'records.bulk_delete', 'customer.commit', 'deals.confirm'] as const) {
      expect(PERMISSIONS[key].approvalLocked).toBe(true);
    }
  });

  it('never lets agents hold permission management or deal confirmation', () => {
    expect(PERMISSIONS['permissions.manage'].agentGrantable).toBe(false);
    expect(PERMISSIONS['deals.confirm'].agentGrantable).toBe(false);
  });

  it('every tool requires a known permission', () => {
    for (const tool of Object.values(TOOLS)) expect(isPermissionKey(tool.requires)).toBe(true);
  });

  it('detects tools whose permission is missing', () => {
    expect(toolsMissingPermissions(['save_lead', 'read_leads'], ['leads.read'])).toEqual(['save_lead']);
    expect(toolsMissingPermissions(['save_lead'], ['leads.write'])).toEqual([]);
  });

  describe('default agent catalog', () => {
    it('has the required hierarchy: 1 GM, 2 managers, 12 workers', () => {
      expect(AGENTS.filter((a) => a.kind === 'GENERAL_MANAGER')).toHaveLength(1);
      expect(AGENTS.filter((a) => a.kind === 'MANAGER').map((a) => a.key).sort()).toEqual(['marketing_manager', 'sales_manager']);
      expect(AGENTS.filter((a) => a.kind === 'WORKER' && a.parent === 'sales_manager')).toHaveLength(6);
      expect(AGENTS.filter((a) => a.kind === 'WORKER' && a.parent === 'marketing_manager')).toHaveLength(6);
    });

    it('lists parents before children (seed relies on this)', () => {
      const seen = new Set<string>();
      for (const a of AGENTS) {
        if (a.parent) expect(seen.has(a.parent)).toBe(true);
        seen.add(a.key);
      }
    });

    it.each(AGENTS.map((a) => [a.key, a] as const))('%s only uses registered tools it has permission for', (_key, agent) => {
      expect(agent.tools.every(isToolName)).toBe(true);
      expect(agent.permissions.every(isPermissionKey)).toBe(true);
      expect(agent.permissions.every((p) => PERMISSIONS[p].agentGrantable)).toBe(true);
      expect(toolsMissingPermissions(agent.tools, agent.permissions)).toEqual([]);
    });

    it('does not create a software development department', () => {
      expect(AGENTS.some((a) => /develop|engineer|coder/i.test(a.key))).toBe(false);
    });
  });
});
