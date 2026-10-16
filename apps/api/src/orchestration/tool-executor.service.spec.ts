import { ToolExecutorService } from './tool-executor.service';

describe('ToolExecutorService.authorize', () => {
  const tools = new ToolExecutorService(null as never, null as never, null as never, null as never, null as never, null as never);

  const base = {
    agentTools: ['delegate_task', 'submit_result'],
    agentPermissions: ['tasks.delegate', 'tasks.report'],
  };

  it('allows phase-2 tools the agent holds', () => {
    expect(tools.authorize('delegate_task', base)).toBeNull();
    expect(tools.authorize('submit_result', base)).toBeNull();
  });

  it('rejects unknown tools', () => {
    expect(tools.authorize('shell_exec', base)).toMatch(/Unknown tool/);
  });

  it('rejects tools not on the agent', () => {
    expect(tools.authorize('delegate_task', { ...base, agentTools: ['submit_result'] })).toMatch(/not configured/);
  });

  it('rejects tools whose permission the agent lacks', () => {
    expect(
      tools.authorize('delegate_task', { agentTools: ['delegate_task'], agentPermissions: ['tasks.report'] }),
    ).toMatch(/lacks permission/);
  });

  it('allows search_lead_sources in the current phase when the agent holds it', () => {
    expect(
      tools.authorize('search_lead_sources', {
        agentTools: ['search_lead_sources'],
        agentPermissions: ['leads.discover'],
      }),
    ).toBeNull();
  });

  it('allows request_send_outreach in the current phase when the agent holds it', () => {
    expect(
      tools.authorize('request_send_outreach', {
        agentTools: ['request_send_outreach'],
        agentPermissions: ['outreach.send'],
      }),
    ).toBeNull();
  });

  it('allows marketing tools in the current phase', () => {
    expect(
      tools.authorize('create_campaign_proposal', {
        agentTools: ['create_campaign_proposal'],
        agentPermissions: ['campaigns.plan'],
      }),
    ).toBeNull();
  });
});
