/**
 * Server-side registry of the only tools and permissions AI agents can ever be given.
 *
 * - Agents never get shell, filesystem or SQL access: no such tool exists here.
 * - The API rejects tool/permission names that are not in this registry.
 * - Some permissions are never grantable to an agent (they belong to the CEO).
 * - Sensitive permissions are approval-locked: exercising them always creates an approval request.
 */

export type PermissionKey =
  | 'tasks.read'
  | 'tasks.delegate'
  | 'tasks.report'
  | 'leads.read'
  | 'leads.discover'
  | 'leads.write'
  | 'leads.score'
  | 'research.read_public'
  | 'outreach.draft'
  | 'outreach.send'
  | 'outreach.follow_up'
  | 'crm.update'
  | 'reports.generate'
  | 'campaigns.plan'
  | 'campaigns.launch_paid'
  | 'content.draft'
  | 'content.publish'
  | 'analytics.read'
  | 'notifications.send'
  | 'messages.send'
  | 'files.share_sensitive'
  | 'records.bulk_delete'
  | 'customer.commit'
  | 'deals.confirm'
  | 'permissions.manage';

export interface PermissionDefinition {
  key: PermissionKey;
  description: string;
  /** false → only humans (CEO/admin) can ever hold it */
  agentGrantable: boolean;
  /** true → every use requires an approved approval request; cannot be switched off */
  approvalLocked: boolean;
}

export const PERMISSIONS: Record<PermissionKey, PermissionDefinition> = {
  'tasks.read': { key: 'tasks.read', description: 'Read tasks in its own scope', agentGrantable: true, approvalLocked: false },
  'tasks.delegate': { key: 'tasks.delegate', description: 'Create subtasks for agents it manages', agentGrantable: true, approvalLocked: false },
  'tasks.report': { key: 'tasks.report', description: 'Submit structured results for its tasks', agentGrantable: true, approvalLocked: false },
  'leads.read': { key: 'leads.read', description: 'Read lead records', agentGrantable: true, approvalLocked: false },
  'leads.discover': { key: 'leads.discover', description: 'Query configured, authorized lead sources', agentGrantable: true, approvalLocked: false },
  'leads.write': { key: 'leads.write', description: 'Create and update lead records', agentGrantable: true, approvalLocked: false },
  'leads.score': { key: 'leads.score', description: 'Store lead qualification scores', agentGrantable: true, approvalLocked: false },
  'research.read_public': { key: 'research.read_public', description: 'Read public web pages via the approved research tool', agentGrantable: true, approvalLocked: false },
  'outreach.draft': { key: 'outreach.draft', description: 'Create outreach drafts for review', agentGrantable: true, approvalLocked: false },
  'outreach.send': { key: 'outreach.send', description: 'Send external emails or direct messages', agentGrantable: true, approvalLocked: true },
  'outreach.follow_up': { key: 'outreach.follow_up', description: 'Schedule follow-ups and record outreach events', agentGrantable: true, approvalLocked: false },
  'crm.update': { key: 'crm.update', description: 'Move leads between pipeline stages (except Won)', agentGrantable: true, approvalLocked: false },
  'reports.generate': { key: 'reports.generate', description: 'Generate reports into controlled storage', agentGrantable: true, approvalLocked: false },
  'campaigns.plan': { key: 'campaigns.plan', description: 'Create campaign proposals', agentGrantable: true, approvalLocked: false },
  'campaigns.launch_paid': { key: 'campaigns.launch_paid', description: 'Launch paid campaigns / spend ad budget', agentGrantable: true, approvalLocked: true },
  'content.draft': { key: 'content.draft', description: 'Create marketing content drafts', agentGrantable: true, approvalLocked: false },
  'content.publish': { key: 'content.publish', description: 'Publish marketing content externally', agentGrantable: true, approvalLocked: true },
  'analytics.read': { key: 'analytics.read', description: 'Read campaign and pipeline analytics', agentGrantable: true, approvalLocked: false },
  'notifications.send': { key: 'notifications.send', description: 'Send in-app notifications to the CEO', agentGrantable: true, approvalLocked: false },
  'messages.send': { key: 'messages.send', description: 'Post a message into the CEO team inbox', agentGrantable: true, approvalLocked: false },
  'files.share_sensitive': { key: 'files.share_sensitive', description: 'Share sensitive files externally', agentGrantable: true, approvalLocked: true },
  'records.bulk_delete': { key: 'records.bulk_delete', description: 'Delete records in bulk', agentGrantable: true, approvalLocked: true },
  'customer.commit': { key: 'customer.commit', description: 'Make commitments to customers (scope, price, dates)', agentGrantable: true, approvalLocked: true },
  'deals.confirm': { key: 'deals.confirm', description: 'Confirm a deal or financial amount', agentGrantable: false, approvalLocked: true },
  'permissions.manage': { key: 'permissions.manage', description: 'Change agent tools or permissions', agentGrantable: false, approvalLocked: true },
};

export type ToolName =
  | 'delegate_task'
  | 'submit_result'
  | 'search_lead_sources'
  | 'read_leads'
  | 'save_lead'
  | 'save_lead_score'
  | 'fetch_public_page'
  | 'create_outreach_draft'
  | 'request_send_outreach'
  | 'schedule_follow_up'
  | 'update_lead_stage'
  | 'generate_report'
  | 'create_campaign_proposal'
  | 'request_launch_paid_campaign'
  | 'create_content_draft'
  | 'request_publish_content'
  | 'read_analytics'
  | 'notify_ceo'
  | 'message_ceo';

export interface ToolDefinition {
  name: ToolName;
  description: string;
  /** Permission the calling agent must hold */
  requires: PermissionKey;
  /** Phase in which the executor is implemented (tools are declarative until then) */
  availableFromPhase: number;
}

export const TOOLS: Record<ToolName, ToolDefinition> = {
  delegate_task: { name: 'delegate_task', description: 'Create a subtask for a subordinate agent', requires: 'tasks.delegate', availableFromPhase: 2 },
  submit_result: { name: 'submit_result', description: 'Return a structured, schema-validated result for the current task', requires: 'tasks.report', availableFromPhase: 2 },
  search_lead_sources: { name: 'search_lead_sources', description: 'Search configured, authorized lead source connectors', requires: 'leads.discover', availableFromPhase: 4 },
  read_leads: { name: 'read_leads', description: 'Read existing lead records', requires: 'leads.read', availableFromPhase: 3 },
  save_lead: { name: 'save_lead', description: 'Create or update a lead with its source evidence', requires: 'leads.write', availableFromPhase: 3 },
  save_lead_score: { name: 'save_lead_score', description: 'Store a rubric-based lead score with reasons', requires: 'leads.score', availableFromPhase: 3 },
  fetch_public_page: { name: 'fetch_public_page', description: 'Fetch a public web page through the rate-limited research tool', requires: 'research.read_public', availableFromPhase: 6 },
  create_outreach_draft: { name: 'create_outreach_draft', description: 'Save an editable outreach draft with rationale', requires: 'outreach.draft', availableFromPhase: 3 },
  request_send_outreach: { name: 'request_send_outreach', description: 'Request approval to send an outreach message through an authorized channel', requires: 'outreach.send', availableFromPhase: 5 },
  schedule_follow_up: { name: 'schedule_follow_up', description: 'Schedule a follow-up draft (respects opt-outs)', requires: 'outreach.follow_up', availableFromPhase: 4 },
  update_lead_stage: { name: 'update_lead_stage', description: 'Move a lead to another pipeline stage (cannot mark Won)', requires: 'crm.update', availableFromPhase: 3 },
  generate_report: { name: 'generate_report', description: 'Generate a Marketing Manager daily/weekly report from counted metrics', requires: 'reports.generate', availableFromPhase: 6 },
  create_campaign_proposal: { name: 'create_campaign_proposal', description: 'Save an editable campaign proposal', requires: 'campaigns.plan', availableFromPhase: 6 },
  request_launch_paid_campaign: { name: 'request_launch_paid_campaign', description: 'Request approval to launch a paid campaign', requires: 'campaigns.launch_paid', availableFromPhase: 6 },
  create_content_draft: { name: 'create_content_draft', description: 'Save a marketing content draft', requires: 'content.draft', availableFromPhase: 6 },
  request_publish_content: { name: 'request_publish_content', description: 'Request approval to publish content externally', requires: 'content.publish', availableFromPhase: 6 },
  read_analytics: { name: 'read_analytics', description: 'Read measured campaign and pipeline metrics', requires: 'analytics.read', availableFromPhase: 6 },
  notify_ceo: { name: 'notify_ceo', description: 'Send a de-duplicated in-app notification to the CEO', requires: 'notifications.send', availableFromPhase: 4 },
  message_ceo: { name: 'message_ceo', description: 'Post a conversational update into the CEO Messages inbox', requires: 'messages.send', availableFromPhase: 6 },
};

export const isPermissionKey = (v: string): v is PermissionKey => Object.prototype.hasOwnProperty.call(PERMISSIONS, v);
export const isToolName = (v: string): v is ToolName => Object.prototype.hasOwnProperty.call(TOOLS, v);

/** Tools whose required permission the agent does not hold. Used to reject inconsistent configs. */
export function toolsMissingPermissions(tools: string[], permissions: string[]): string[] {
  const held = new Set(permissions);
  return tools.filter((t) => isToolName(t) && !held.has(TOOLS[t].requires));
}
