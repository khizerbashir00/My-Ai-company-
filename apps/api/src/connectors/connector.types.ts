import type { SourceAccessMethod } from '../generated/prisma/client';

/** Normalized item ready to become a Lead + LeadSource. Never invent contacts. */
export interface ConnectorLeadCandidate {
  /** Stable id on the source platform when available */
  externalId: string;
  /** Public display name / title (not invented) */
  name: string;
  contactName?: string | null;
  contactEmail?: string | null;
  contactUrl?: string | null;
  websiteUrl?: string | null;
  requirements: string;
  requestedSkills?: string[];
  budgetText?: string | null;
  notes?: string;
  sourceUrl: string;
  postDate?: Date | null;
  discoveredAt: Date;
  rawSnapshot?: Record<string, unknown>;
}

export interface ConnectorPage {
  items: ConnectorLeadCandidate[];
  /** Opaque cursor for the next page; null when done */
  nextCursor: string | null;
  /** Approximate total from the provider when known */
  estimatedTotal?: number;
}

export interface ConnectorScanOptions {
  /** Provider-specific config from SourceConnection.config (no secrets) */
  config: Record<string, unknown>;
  /** Resume cursor from the previous page/run */
  cursor?: string | null;
  /** Hard cap on items for this scan */
  maxResults: number;
  signal?: AbortSignal;
}

export interface ConnectorDescriptor {
  key: string;
  name: string;
  platform: string;
  accessMethod: SourceAccessMethod;
  description: string;
  complianceNotes: string;
  capabilities: string[];
  /** Env var name that must be set when credentials are required; null if none */
  credentialsEnv: string | null;
  /** Keys required in connection.config before the connector is considered configured */
  requiredConfigKeys: string[];
  documentationUrl: string;
  defaultScanIntervalMinutes: number;
  defaultMaxResults: number;
  /** Conservative max HTTP requests per scan (pagination safety) */
  maxPagesPerScan: number;
}

export interface LeadSourceConnector {
  readonly descriptor: ConnectorDescriptor;
  /** Whether required credentials (if any) are present in the environment. */
  isAuthorized(env: NodeJS.ProcessEnv): boolean;
  /** Validate non-secret config; returns error messages. */
  validateConfig(config: Record<string, unknown>): string[];
  /** Fetch one page of candidates. Must respect rate limits and timeouts. */
  fetchPage(options: ConnectorScanOptions): Promise<ConnectorPage>;
}

export const CONNECTOR_REGISTRY = Symbol('CONNECTOR_REGISTRY');
