// Shapes returned by the HQ API (apps/api). Kept by hand and small on purpose.

export type UserRole = 'CEO' | 'ADMIN' | 'VIEWER';
export type TaskStatus = 'QUEUED' | 'RUNNING' | 'AWAITING_APPROVAL' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type TaskKind = 'GOAL' | 'DEPARTMENT_TASK' | 'WORKER_TASK';
export type TaskPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
export type AgentKind = 'GENERAL_MANAGER' | 'MANAGER' | 'WORKER';
export type ModelTier = 'ROUTINE' | 'ADVANCED';

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface Ref {
  id: string;
  name: string;
}

export interface TaskListItem {
  id: string;
  kind: TaskKind;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  attempts: number;
  maxAttempts: number;
  errorMessage: string | null;
  parentTaskId: string | null;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  department: { id: string; key: string; name: string } | null;
  assignedAgent: { id: string; key: string; name: string; kind: AgentKind } | null;
  _count: { subtasks: number };
}

export interface TaskEvent {
  id: string;
  type: string;
  fromStatus: TaskStatus | null;
  toStatus: TaskStatus | null;
  message: string;
  actorType: 'USER' | 'AGENT' | 'SYSTEM';
  actorUser: Ref | null;
  actorAgent: Ref | null;
  createdAt: string;
}

export interface TaskDetail extends TaskListItem {
  startedAt: string | null;
  completedAt: string | null;
  createdBy: Ref | null;
  parentTask: { id: string; title: string; status: TaskStatus } | null;
  subtasks: { id: string; title: string; status: TaskStatus; kind: TaskKind; priority: TaskPriority; assignedAgent: Ref | null }[];
  dependencies: { dependsOn: { id: string; title: string; status: TaskStatus } }[];
  events: TaskEvent[];
  runs: {
    id: string;
    status: string;
    model: string;
    provider: string;
    startedAt: string;
    finishedAt: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    agent: Ref;
  }[];
}

export interface AgentPermission {
  permission: string;
  requiresApproval: boolean;
}

export interface Agent {
  id: string;
  key: string;
  name: string;
  kind: AgentKind;
  role: string;
  instructions: string;
  reportingResponsibilities: string;
  tools: string[];
  modelTier: ModelTier;
  modelOverride: string | null;
  maxOutputTokens: number;
  isEnabled: boolean;
  department: { id: string; key: string; name: string } | null;
  parent: { id: string; key: string; name: string; kind: AgentKind } | null;
  children: { id: string; key: string; name: string; kind: AgentKind; isEnabled: boolean }[];
  permissions: AgentPermission[];
  openTasks: number;
  recentTasks?: { id: string; title: string; status: TaskStatus; priority: TaskPriority; createdAt: string }[];
}

export interface Registry {
  tools: { name: string; description: string; requires: string; availableFromPhase: number }[];
  permissions: { key: string; description: string; agentGrantable: boolean; approvalLocked: boolean }[];
}

export interface Department {
  id: string;
  key: string;
  name: string;
  description: string;
  manager: { id: string; name: string } | null;
  workerCount: number;
  taskStats: { open: number; completed: number; failed: number };
}

export interface OrgNode {
  id: string;
  key: string;
  name: string;
  kind: AgentKind;
  role: string;
  isEnabled: boolean;
  modelTier: ModelTier;
  departmentId: string | null;
  openTasks: number;
  children: OrgNode[];
}

export interface Metrics {
  filters: { from: string | null; to: string | null; sourceId: string | null; departmentId: string | null };
  generatedAt: string;
  sales: {
    leadsTotal: number;
    leadsQualified: number;
    leadsHighIntent: number;
    outreachDrafts: number;
    draftsAwaitingApproval: number;
    messagesSent: number;
    repliesReceived: number;
    interestedProspects: number;
    demoRequests: number;
    negotiations: number;
    meetingsScheduled: number;
    dealsWon: number;
    dealsLost: number;
    revenue: { currency: string; amount: string; deals: number }[];
    pipeline: { stage: string; count: number }[];
  };
  marketing: {
    campaignsByStatus: { status: string; count: number }[];
    assetsPublished: number;
    attributedLeads: number;
    metricImports: number;
    performance: { measured: boolean; note: string; unavailable?: string[] };
  };
  tasks: {
    total: number;
    byStatus: { status: TaskStatus; count: number }[];
    completionRate: number | null;
    failed: number;
    pendingApprovals: number;
    recent: {
      id: string;
      title: string;
      status: TaskStatus;
      priority: TaskPriority;
      kind: TaskKind;
      updatedAt: string;
      assignedAgent: Ref | null;
      department: Ref | null;
    }[];
  };
  aiUsage: {
    measured: boolean;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    calls: number;
    byModel: {
      provider: string;
      model: string;
      calls: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      estimatedUsd: number | null;
      costKind: 'ESTIMATE' | 'UNAVAILABLE';
      rateSource: string | null;
    }[];
    estimatedUsdTotal: number | null;
    costKind: 'ESTIMATE' | 'UNAVAILABLE';
    note: string;
  };
  definitions: Record<string, string>;
}

export interface SystemStatus {
  ai: { provider: string; apiKeyConfigured: boolean; routineModel: string | null; advancedModel: string | null };
  email: {
    provider: string | null;
    configured: boolean;
    fromAddress: string | null;
    replyTo: string | null;
    inboundWebhookConfigured: boolean;
  };
  redisConfigured: boolean;
  limits?: {
    taskDefaultMaxAttempts: number;
    scanJobAttempts: number;
    throttleLimit: number;
    aiDailyEstimatedUsdBudget: number | null;
  };
  monitoring?: {
    tasksFailed: number;
    tasksAwaitingApproval: number;
    pendingApprovals: number;
    unreadCeoNotifications: number;
  };
  sources: {
    id: string;
    key: string;
    name: string;
    platform: string;
    accessMethod: string;
    isEnabled: boolean;
    connectionStatus: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
  }[];
  environment: string;
}

export type LeadStage =
  | 'NEW'
  | 'QUALIFIED'
  | 'DRAFT_READY'
  | 'AWAITING_APPROVAL'
  | 'CONTACTED'
  | 'REPLIED'
  | 'INTERESTED'
  | 'DEMO_REQUESTED'
  | 'DEMO_COMPLETED'
  | 'NEGOTIATION'
  | 'WON'
  | 'LOST'
  | 'DO_NOT_CONTACT';

export type IntentLabel = 'HIGH' | 'MEDIUM' | 'LOW' | 'NEEDS_REVIEW';
export type OutreachStatus = 'DRAFT' | 'AWAITING_APPROVAL' | 'APPROVED' | 'SCHEDULED' | 'SENT' | 'FAILED' | 'CANCELLED';

export interface LeadSourceRef {
  id: string;
  url: string;
  canonicalUrl: string;
  externalId: string | null;
  postDate: string | null;
  discoveredAt: string;
  accessMethod: string;
  source: { id: string; key: string; name: string; platform: string; accessMethod: string };
}

export interface LeadListItem {
  id: string;
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  websiteUrl: string | null;
  stage: LeadStage;
  intentLabel: IntentLabel | null;
  latestScore: number | null;
  doNotContact: boolean;
  requirements: string;
  budgetText: string | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
  assignedAgent: { id: string; key: string; name: string; kind: AgentKind } | null;
  sources: LeadSourceRef[];
  _count: { messages: number; scores: number };
}

export interface OutreachMessage {
  id: string;
  leadId: string;
  channel: string;
  subject: string | null;
  body: string;
  rationale: string;
  status: OutreachStatus;
  createdAt: string;
  updatedAt: string;
}

export interface LeadDetail extends LeadListItem {
  contactUrl: string | null;
  country: string | null;
  industry: string | null;
  requestedSkills: string[];
  optedOutAt: string | null;
  outreachPausedAt: string | null;
  demoScheduledAt: string | null;
  lostReason: string | null;
  scores: {
    id: string;
    score: number;
    label: IntentLabel;
    reasons: { key: string; score: number; reason: string }[];
    rubricVersion: string;
    createdAt: string;
    scoredBy: Ref | null;
  }[];
  messages: OutreachMessage[];
  outreachEvents: { id: string; type: string; occurredAt: string; data: unknown }[];
}

export interface ScoringRubric {
  version: string;
  maxScore: number;
  criteria: { key: string; label: string; max: number; description: string }[];
  labels: Record<string, string>;
}
