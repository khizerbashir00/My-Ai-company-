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
  runs: { id: string; status: string; model: string; provider: string; startedAt: string; finishedAt: string | null; agent: Ref }[];
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
    messagesSent: number;
    repliesReceived: number;
    interestedProspects: number;
    demoRequests: number;
    meetingsScheduled: number;
    dealsWon: number;
    dealsLost: number;
    revenue: { currency: string; amount: string; deals: number }[];
    pipeline: { stage: string; count: number }[];
  };
  marketing: {
    campaignsByStatus: { status: string; count: number }[];
    assetsPublished: number;
    performance: { measured: boolean; note: string };
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
  definitions: Record<string, string>;
}

export interface SystemStatus {
  ai: { provider: string; apiKeyConfigured: boolean; routineModel: string | null; advancedModel: string | null };
  sources: { id: string; key: string; name: string; platform: string; accessMethod: string; isEnabled: boolean }[];
  environment: string;
}
