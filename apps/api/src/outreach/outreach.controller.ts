import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public, AuthUser, CurrentUser, ReqContext, RequestContext, Roles, WRITE_ROLES } from '../common/auth.decorators';
import { AppConfigService } from '../config/app-config.service';
import {
  ConfirmDealDto,
  IngestReplyDto,
  RequestSendDto,
  ScheduleFollowUpDto,
} from './outreach.dto';
import { OutreachService } from './outreach.service';

@Controller()
export class OutreachController {
  constructor(
    private readonly outreach: OutreachService,
    private readonly config: AppConfigService,
  ) {}

  @Get('email/status')
  emailStatus() {
    return this.outreach.providerStatus();
  }

  @Get('outreach/messages/:messageId/review')
  review(@Param('messageId', ParseUUIDPipe) messageId: string) {
    return this.outreach.getReviewBundle(messageId);
  }

  @Roles(...WRITE_ROLES)
  @Post('leads/:leadId/outreach/:messageId/request-send')
  @HttpCode(200)
  requestSend(
    @Param('leadId', ParseUUIDPipe) leadId: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Body() dto: RequestSendDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.outreach.requestSend(leadId, messageId, dto, user, ctx);
  }

  @Roles(...WRITE_ROLES)
  @Post('leads/:leadId/follow-ups')
  scheduleFollowUp(
    @Param('leadId', ParseUUIDPipe) leadId: string,
    @Body() dto: ScheduleFollowUpDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.outreach.scheduleFollowUp(leadId, dto, user, ctx);
  }

  @Roles(...WRITE_ROLES)
  @Post('leads/:leadId/outreach/pause')
  @HttpCode(200)
  pause(@Param('leadId', ParseUUIDPipe) leadId: string, @CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.outreach.pauseOutreach(leadId, user, ctx);
  }

  @Roles(...WRITE_ROLES)
  @Post('leads/:leadId/outreach/resume')
  @HttpCode(200)
  resume(@Param('leadId', ParseUUIDPipe) leadId: string, @CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.outreach.resumeOutreach(leadId, user, ctx);
  }

  @Roles(...WRITE_ROLES)
  @Post('leads/:leadId/outreach/stop-scheduled')
  @HttpCode(200)
  stop(@Param('leadId', ParseUUIDPipe) leadId: string, @CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.outreach.stopScheduledOutreach(leadId, user, ctx);
  }

  @Roles(...WRITE_ROLES)
  @Post('leads/:leadId/confirm-deal')
  @HttpCode(200)
  confirmDeal(
    @Param('leadId', ParseUUIDPipe) leadId: string,
    @Body() dto: ConfirmDealDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.outreach.confirmDeal(leadId, dto, user, ctx);
  }

  /**
   * Inbound reply webhook (Resend-compatible JSON). Public but rejects when webhook secret is set
   * and Authorization/svix header does not match. Without a secret, only accepted in non-production.
   */
  @Public()
  @Post('webhooks/email/inbound')
  @HttpCode(200)
  async inboundWebhook(@Req() req: Request, @Body() body: Record<string, unknown>) {
    const secret = this.config.resendWebhookSecret;
    if (secret) {
      const auth = req.headers.authorization ?? req.headers['svix-signature'] ?? '';
      const token = Array.isArray(auth) ? auth[0] : auth;
      if (!token || !String(token).includes(secret)) {
        return { ok: false, error: 'Unauthorized webhook' };
      }
    } else if (this.config.isProduction) {
      return { ok: false, error: 'RESEND_WEBHOOK_SECRET required in production' };
    }

    const dto = normalizeInbound(body);
    if (!dto) return { ok: false, error: 'Unrecognized inbound payload' };
    const result = await this.outreach.ingestReply(dto, 'resend');
    return { ok: true, replyId: result.reply.id, deduplicated: result.deduplicated, matchStatus: result.reply.matchStatus };
  }
}

function normalizeInbound(body: Record<string, unknown>): IngestReplyDto | null {
  // Direct test / internal shape
  if (typeof body.fromEmail === 'string' && typeof body.providerMessageId === 'string' && typeof body.bodyText === 'string') {
    return {
      fromEmail: body.fromEmail,
      toEmail: typeof body.toEmail === 'string' ? body.toEmail : undefined,
      subject: typeof body.subject === 'string' ? body.subject : undefined,
      bodyText: body.bodyText,
      providerMessageId: body.providerMessageId,
      inReplyTo: typeof body.inReplyTo === 'string' ? body.inReplyTo : undefined,
    };
  }

  // Resend inbound-ish / email.received
  const data = (body.data && typeof body.data === 'object' ? body.data : body) as Record<string, unknown>;
  const from = typeof data.from === 'string' ? data.from : typeof data.from_email === 'string' ? data.from_email : null;
  const id = typeof data.email_id === 'string' ? data.email_id : typeof data.id === 'string' ? data.id : null;
  const text =
    typeof data.text === 'string'
      ? data.text
      : typeof data.body === 'string'
        ? data.body
        : typeof data.html === 'string'
          ? stripHtml(data.html)
          : null;
  if (!from || !id || text == null) return null;
  return {
    fromEmail: extractEmail(from),
    toEmail: typeof data.to === 'string' ? extractEmail(data.to) : undefined,
    subject: typeof data.subject === 'string' ? data.subject : undefined,
    bodyText: text,
    providerMessageId: id,
    inReplyTo: typeof data.in_reply_to === 'string' ? data.in_reply_to : undefined,
  };
}

function extractEmail(v: string): string {
  const m = v.match(/<([^>]+)>/);
  return (m?.[1] ?? v).trim().toLowerCase();
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
