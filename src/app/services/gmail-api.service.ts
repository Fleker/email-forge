import { Injectable, inject, signal, computed } from '@angular/core';
import {
  CategorizedEmail,
  CategoryId,
  GmailAccount,
  OAuthClientConfig,
  OutboundEmailRequest,
  RawEmailMessage,
  SentEmailRecord,
} from '../models/mail.model';
import { CategoryRegistryService } from './category-registry.service';

const ACCOUNTS_STORAGE_KEY = 'mail_forge_accounts';
const OAUTH_CONFIG_STORAGE_KEY = 'mail_forge_oauth_config';
const MESSAGES_CACHE_STORAGE_KEY = 'mail_forge_messages_cache';

const ACCOUNT_PALETTE = [
  '#2563eb',
  '#7c3aed',
  '#059669',
  '#d97706',
  '#dc2626',
  '#0891b2',
];

@Injectable({
  providedIn: 'root',
})
export class GmailApiService {
  private readonly categoryRegistry = inject(CategoryRegistryService);

  readonly oauthConfig = signal<OAuthClientConfig>(this.loadOAuthConfig());
  readonly accounts = signal<GmailAccount[]>(this.loadAccounts());
  readonly rawMessages = signal<RawEmailMessage[]>(this.loadCachedMessages());
  readonly sentMessages = signal<SentEmailRecord[]>([]);
  readonly isSyncing = signal<boolean>(false);
  readonly lastSyncTime = signal<string | null>(null);
  readonly syncError = signal<string | null>(null);

  readonly categorizedEmails = computed<CategorizedEmail[]>(() => {
    // Re-evaluate whenever rawMessages or custom category plugins change
    this.categoryRegistry.plugins();
    return this.rawMessages()
      .filter((msg) => !msg.archived)
      .sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      )
      .map((msg) => this.categoryRegistry.categorize(msg));
  });

  saveOAuthConfig(config: OAuthClientConfig): void {
    const normalized: OAuthClientConfig = {
      clientId: config.clientId.trim(),
      clientSecret: config.clientSecret.trim(),
      redirectUri:
        config.redirectUri.trim() || window.location.origin + window.location.pathname,
    };
    this.oauthConfig.set(normalized);
    try {
      localStorage.setItem(OAUTH_CONFIG_STORAGE_KEY, JSON.stringify(normalized));
    } catch {
      // Ignore storage error
    }
  }

  buildGoogleOAuthUrl(loginHint?: string): string {
    const cfg = this.oauthConfig();
    const defaultRedirect =
      typeof window !== 'undefined'
        ? window.location.origin + window.location.pathname
        : 'http://localhost:4205/';
    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri || defaultRedirect,
      response_type: 'code',
      scope:
        'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/userinfo.email',
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
    });
    if (loginHint) {
      params.set('login_hint', loginHint);
    }
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async handleOAuthCallbackIfPresent(): Promise<GmailAccount | null> {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (!code) return null;

    // Clean URL query params immediately so refresh doesn't re-submit code
    window.history.replaceState({}, document.title, window.location.pathname);
    return this.exchangeCodeForAccount(code);
  }

  async exchangeCodeForAccount(code: string): Promise<GmailAccount> {
    const cfg = this.oauthConfig();
    if (!cfg.clientId || !cfg.clientSecret) {
      throw new Error('Configure OAuth Client ID and Client Secret first.');
    }

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        redirect_uri:
          cfg.redirectUri || window.location.origin + window.location.pathname,
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      throw new Error(`OAuth token exchange failed: ${errText}`);
    }

    const tokenData = await tokenRes.json();
    const accessToken: string = tokenData.access_token;
    const refreshToken: string | undefined = tokenData.refresh_token;
    const expiresIn: number = tokenData.expires_in || 3600;

    // Fetch Gmail profile to get email address & historyId
    const profileRes = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/profile',
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    if (!profileRes.ok) {
      throw new Error('Failed to fetch Gmail profile after authentication.');
    }
    const profile = await profileRes.json();
    const email: string = profile.emailAddress;

    const existing = this.accounts().find(
      (a) => a.email.toLowerCase() === email.toLowerCase()
    );
    const color =
      existing?.color ||
      ACCOUNT_PALETTE[this.accounts().length % ACCOUNT_PALETTE.length];

    const account: GmailAccount = {
      id: existing?.id || `acct_${email.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`,
      email,
      label: existing?.label || email.split('@')[0],
      color,
      accessToken,
      refreshToken: refreshToken || existing?.refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
      lastHistoryId: profile.historyId,
      isDemo: false,
    };

    this.upsertAccount(account);
    await this.syncAccountMessages(account);
    return account;
  }

  upsertAccount(account: GmailAccount): void {
    const updated = [
      ...this.accounts().filter((a) => a.id !== account.id),
      account,
    ];
    this.accounts.set(updated);
    this.saveAccounts(updated);
  }

  removeAccount(accountId: string): void {
    const updated = this.accounts().filter((a) => a.id !== accountId);
    this.accounts.set(updated);
    this.saveAccounts(updated);

    const remainingMessages = this.rawMessages().filter(
      (m) => m.accountId !== accountId
    );
    this.rawMessages.set(remainingMessages);
    this.saveCachedMessages(remainingMessages);
  }

  async ensureValidAccessToken(account: GmailAccount): Promise<string> {
    if (account.isDemo) {
      return 'demo-token';
    }
    if (
      account.accessToken &&
      account.expiresAt &&
      Date.now() < account.expiresAt - 60_000
    ) {
      return account.accessToken;
    }

    if (!account.refreshToken) {
      throw new Error(
        `Missing refresh token for ${account.email}. Re-connect with prompt=consent.`
      );
    }

    const cfg = this.oauthConfig();
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        refresh_token: account.refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!res.ok) {
      throw new Error(`Token refresh failed for ${account.email}`);
    }

    const data = await res.json();
    const updatedAccount: GmailAccount = {
      ...account,
      accessToken: data.access_token,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
    };
    this.upsertAccount(updatedAccount);
    return updatedAccount.accessToken!;
  }

  async syncAllAccounts(): Promise<void> {
    this.isSyncing.set(true);
    this.syncError.set(null);
    try {
      const liveAccounts = this.accounts().filter((a) => !a.isDemo);
      await Promise.all(
        liveAccounts.map((acct) => this.syncAccountMessages(acct))
      );
      this.lastSyncTime.set(new Date().toLocaleTimeString());
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.syncError.set(msg);
    } finally {
      this.isSyncing.set(false);
    }
  }

  async syncAccountMessages(account: GmailAccount): Promise<void> {
    if (account.isDemo) return;
    const token = await this.ensureValidAccessToken(account);
    const listUrl =
      'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=in:inbox&maxResults=35';
    const listRes = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!listRes.ok) {
      throw new Error(`Failed to list messages for ${account.email}`);
    }
    const listData = await listRes.json();
    const messageRefs: Array<{ id: string; threadId: string }> =
      listData.messages || [];

    const fetchedMessages = await Promise.all(
      messageRefs.map(async (ref) => {
        const msgRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${ref.id}?format=full`,
          {
            headers: { Authorization: `Bearer ${token}` },
          }
        );
        if (!msgRes.ok) return null;
        const msgJson = await msgRes.json();
        return this.parseGmailApiMessage(msgJson, account);
      })
    );

    const validNew = fetchedMessages.filter(
      (m): m is RawEmailMessage => m !== null
    );
    const otherAccountMessages = this.rawMessages().filter(
      (m) => m.accountId !== account.id
    );
    const merged = [...otherAccountMessages, ...validNew];
    this.rawMessages.set(merged);
    this.saveCachedMessages(merged);
  }

  async archiveEmail(emailId: string): Promise<void> {
    const target = this.rawMessages().find((m) => m.id === emailId);
    if (!target) return;

    // Optimistic local state update
    const updated = this.rawMessages().map((m) =>
      m.id === emailId ? { ...m, archived: true, unread: false } : m
    );
    this.rawMessages.set(updated);
    this.saveCachedMessages(updated);

    const account = this.accounts().find((a) => a.id === target.accountId);
    if (account && !account.isDemo) {
      try {
        const token = await this.ensureValidAccessToken(account);
        await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${target.id}/modify`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              removeLabelIds: ['INBOX', 'UNREAD'],
            }),
          }
        );
      } catch (err) {
        console.error('Failed to sync archive to Gmail API:', err);
      }
    }
  }

  async archiveBatch(emailIds: string[]): Promise<void> {
    const idSet = new Set(emailIds);
    const targets = this.rawMessages().filter((m) => idSet.has(m.id));
    if (targets.length === 0) return;

    const updated = this.rawMessages().map((m) =>
      idSet.has(m.id) ? { ...m, archived: true, unread: false } : m
    );
    this.rawMessages.set(updated);
    this.saveCachedMessages(updated);

    // Group live messages by account for Gmail batchModify
    const byAccount = new Map<string, string[]>();
    for (const msg of targets) {
      const list = byAccount.get(msg.accountId) || [];
      list.push(msg.id);
      byAccount.set(msg.accountId, list);
    }

    for (const [accountId, ids] of byAccount.entries()) {
      const account = this.accounts().find((a) => a.id === accountId);
      if (account && !account.isDemo) {
        try {
          const token = await this.ensureValidAccessToken(account);
          await fetch(
            'https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify',
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                ids,
                removeLabelIds: ['INBOX', 'UNREAD'],
              }),
            }
          );
        } catch (err) {
          console.error('Failed batchArchive on Gmail API:', err);
        }
      }
    }
  }

  async toggleStar(emailId: string): Promise<void> {
    const target = this.rawMessages().find((m) => m.id === emailId);
    if (!target) return;
    const nextStarred = !target.starred;

    const updated = this.rawMessages().map((m) =>
      m.id === emailId ? { ...m, starred: nextStarred } : m
    );
    this.rawMessages.set(updated);
    this.saveCachedMessages(updated);

    const account = this.accounts().find((a) => a.id === target.accountId);
    if (account && !account.isDemo) {
      try {
        const token = await this.ensureValidAccessToken(account);
        await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${target.id}/modify`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(
              nextStarred
                ? { addLabelIds: ['STARRED'] }
                : { removeLabelIds: ['STARRED'] }
            ),
          }
        );
      } catch (err) {
        console.error('Failed to toggle star on Gmail API:', err);
      }
    }
  }

  async markAsRead(emailId: string): Promise<void> {
    const target = this.rawMessages().find((m) => m.id === emailId);
    if (!target || !target.unread) return;

    const updated = this.rawMessages().map((m) =>
      m.id === emailId ? { ...m, unread: false } : m
    );
    this.rawMessages.set(updated);
    this.saveCachedMessages(updated);

    const account = this.accounts().find((a) => a.id === target.accountId);
    if (account && !account.isDemo) {
      try {
        const token = await this.ensureValidAccessToken(account);
        await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${target.id}/modify`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
          }
        );
      } catch (err) {
        console.error('Failed to mark read on Gmail API:', err);
      }
    }
  }

  async sendEmail(request: OutboundEmailRequest): Promise<SentEmailRecord> {
    const senderAccount =
      this.accounts().find((a) => a.id === request.fromAccountId) ||
      this.accounts()[0];
    if (!senderAccount) {
      throw new Error('No sender Gmail account available.');
    }

    const to = request.to.trim();
    if (!to) {
      throw new Error('Recipient email address is required.');
    }

    const cc = request.cc?.trim() || undefined;
    const subject = request.subject.trim() || '(No Subject)';
    let fullBody = request.body.trim();

    if (request.mode === 'reply' && request.originalEmail) {
      const orig = request.originalEmail.raw;
      const quotedLines = (orig.bodyText || orig.snippet)
        .split(/\r?\n/)
        .map((line) => `> ${line}`)
        .join('\r\n');
      fullBody = [
        fullBody,
        '',
        `On ${new Date(orig.timestamp).toLocaleString()}, ${orig.fromName} <${orig.fromEmail}> wrote:`,
        quotedLines,
      ].join('\r\n');
    } else if (request.mode === 'forward' && request.originalEmail) {
      const orig = request.originalEmail.raw;
      fullBody = [
        fullBody,
        '',
        '---------- Forwarded message ---------',
        `From: ${orig.fromName} <${orig.fromEmail}>`,
        `Date: ${new Date(orig.timestamp).toLocaleString()}`,
        `Subject: ${orig.subject}`,
        `To: ${orig.toEmail}`,
        '',
        orig.bodyText || orig.snippet,
      ].join('\r\n');
    }

    const sameAccountThreadId =
      request.mode === 'reply' &&
      request.originalEmail &&
      request.originalEmail.raw.accountId === senderAccount.id
        ? request.originalEmail.raw.threadId
        : undefined;

    if (!senderAccount.isDemo) {
      const token = await this.ensureValidAccessToken(senderAccount);
      const headerLines = [
        `To: ${to}`,
        `From: "${senderAccount.label}" <${senderAccount.email}>`,
      ];
      if (cc) {
        headerLines.push(`Cc: ${cc}`);
      }
      headerLines.push(`Subject: ${subject}`);
      if (request.mode === 'reply' && request.originalEmail) {
        const msgIdHeader =
          request.originalEmail.raw.headers['message-id'] ||
          `<${request.originalEmail.raw.id}@mail.gmail.com>`;
        headerLines.push(`In-Reply-To: ${msgIdHeader}`);
        headerLines.push(`References: ${msgIdHeader}`);
      }
      headerLines.push('Content-Type: text/plain; charset="UTF-8"');

      const rfc2822 = [...headerLines, '', fullBody].join('\r\n');
      const rawBase64Url = btoa(unescape(encodeURIComponent(rfc2822)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      const payloadBody: Record<string, string> = { raw: rawBase64Url };
      if (sameAccountThreadId) {
        payloadBody['threadId'] = sameAccountThreadId;
      }

      const res = await fetch(
        'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payloadBody),
        }
      );
      if (!res.ok) {
        throw new Error(`Gmail send failed: ${await res.text()}`);
      }
    }

    const record: SentEmailRecord = {
      id: `sent_${Date.now()}`,
      mode: request.mode,
      fromAccountId: senderAccount.id,
      fromEmail: senderAccount.email,
      to,
      cc,
      subject,
      body: fullBody,
      threadId: sameAccountThreadId,
      sentAt: new Date().toISOString(),
    };
    this.sentMessages.update((prev) => [record, ...prev]);
    return record;
  }

  async forwardEmail(
    email: CategorizedEmail,
    toAddress: string,
    note: string,
    fromAccountId?: string
  ): Promise<void> {
    const subject = email.raw.subject.toLowerCase().startsWith('fwd:')
      ? email.raw.subject
      : `Fwd: ${email.raw.subject}`;
    await this.sendEmail({
      mode: 'forward',
      fromAccountId: fromAccountId || email.raw.accountId,
      to: toAddress,
      subject,
      body: note,
      originalEmail: email,
    });
  }

  resetDemoData(): void {
    const demoAccounts = this.getDefaultDemoAccounts();
    const demoMessages = this.getDefaultDemoMessages();
    this.accounts.set(demoAccounts);
    this.rawMessages.set(demoMessages);
    this.saveAccounts(demoAccounts);
    this.saveCachedMessages(demoMessages);
  }

  parseGmailApiMessage(
    msgJson: Record<string, any>,
    account: GmailAccount
  ): RawEmailMessage {
    const payload = msgJson['payload'] || {};
    const rawHeaders: Array<{ name: string; value: string }> =
      payload.headers || [];
    const headers: Record<string, string> = {};
    for (const h of rawHeaders) {
      headers[h.name.toLowerCase()] = h.value;
    }

    const fromHeader = headers['from'] || 'Unknown';
    const { name: fromName, email: fromEmail } = this.parseAddress(fromHeader);
    const toEmail = headers['to'] || account.email;
    const subject = headers['subject'] || '(No Subject)';
    const internalDateMs = Number(msgJson['internalDate']) || Date.now();
    const labelIds: string[] = msgJson['labelIds'] || [];

    const { text, html } = this.extractMimeBodies(payload);

    return {
      id: msgJson['id'],
      threadId: msgJson['threadId'] || msgJson['id'],
      accountId: account.id,
      accountEmail: account.email,
      fromName,
      fromEmail,
      toEmail,
      subject,
      snippet: msgJson['snippet'] || text.slice(0, 160),
      bodyText: text || msgJson['snippet'] || '',
      bodyHtml: html || '',
      timestamp: new Date(internalDateMs).toISOString(),
      unread: labelIds.includes('UNREAD'),
      starred: labelIds.includes('STARRED'),
      archived: !labelIds.includes('INBOX'),
      labels: labelIds,
      headers,
    };
  }

  private parseAddress(raw: string): { name: string; email: string } {
    const angleMatch = raw.match(/^(.*?)\s*<([^>]+)>$/);
    if (angleMatch) {
      const name = angleMatch[1].replace(/^["']|["']$/g, '').trim();
      const email = angleMatch[2].trim();
      return { name: name || email.split('@')[0], email };
    }
    return { name: raw.trim(), email: raw.trim() };
  }

  private extractMimeBodies(payload: Record<string, any>): {
    text: string;
    html: string;
  } {
    let text = '';
    let html = '';

    const walk = (part: Record<string, any>) => {
      if (!part) return;
      const mimeType: string = part['mimeType'] || '';
      const data: string | undefined = part['body']?.['data'];
      if (data) {
        const decoded = this.decodeBase64Url(data);
        if (mimeType === 'text/plain' && !text) {
          text = decoded;
        } else if (mimeType === 'text/html' && !html) {
          html = decoded;
        }
      }
      const subParts: Array<Record<string, any>> = part['parts'] || [];
      for (const sub of subParts) {
        walk(sub);
      }
    };

    walk(payload);
    return { text, html };
  }

  private decodeBase64Url(input: string): string {
    try {
      const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
      return decodeURIComponent(escape(atob(base64)));
    } catch {
      return '';
    }
  }

  private loadOAuthConfig(): OAuthClientConfig {
    try {
      const raw = localStorage.getItem(OAUTH_CONFIG_STORAGE_KEY);
      if (raw) {
        return JSON.parse(raw);
      }
    } catch {
      // Ignore
    }
    return {
      clientId: '',
      clientSecret: '',
      redirectUri:
        typeof window !== 'undefined'
          ? window.location.origin + window.location.pathname
          : 'http://localhost:4205/',
    };
  }

  private loadAccounts(): GmailAccount[] {
    try {
      const raw = localStorage.getItem(ACCOUNTS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    } catch {
      // Ignore
    }
    return this.getDefaultDemoAccounts();
  }

  private saveAccounts(accounts: GmailAccount[]): void {
    try {
      localStorage.setItem(ACCOUNTS_STORAGE_KEY, JSON.stringify(accounts));
    } catch {
      // Ignore
    }
  }

  private loadCachedMessages(): RawEmailMessage[] {
    try {
      const raw = localStorage.getItem(MESSAGES_CACHE_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    } catch {
      // Ignore
    }
    return this.getDefaultDemoMessages();
  }

  private saveCachedMessages(messages: RawEmailMessage[]): void {
    try {
      localStorage.setItem(MESSAGES_CACHE_STORAGE_KEY, JSON.stringify(messages));
    } catch {
      // Ignore
    }
  }

  private getDefaultDemoAccounts(): GmailAccount[] {
    return [
      {
        id: 'acct_personal',
        email: 'nick.personal@gmail.com',
        label: 'Personal',
        color: '#2563eb',
        isDemo: true,
      },
      {
        id: 'acct_dev',
        email: 'fleker.dev@gmail.com',
        label: 'Dev & OSS',
        color: '#7c3aed',
        isDemo: true,
      },
      {
        id: 'acct_commerce',
        email: 'nick.shopping@gmail.com',
        label: 'Orders & Bills',
        color: '#059669',
        isDemo: true,
      },
    ];
  }

  private getDefaultDemoMessages(): RawEmailMessage[] {
    return [
      // 1. 2FA Codes
      {
        id: 'msg_2fa_1',
        threadId: 'th_2fa_1',
        accountId: 'acct_dev',
        accountEmail: 'fleker.dev@gmail.com',
        fromName: 'GitHub',
        fromEmail: 'noreply@github.com',
        toEmail: 'fleker.dev@gmail.com',
        subject: '[GitHub] Your two-factor authentication code is 849204',
        snippet: 'Your GitHub verification code is 849204. This code expires in 10 minutes.',
        bodyText:
          'Hey fleker!\n\nA sign-in attempt requires further verification. Your verification code is: 849204\n\nThis code expires in 10 minutes.\nhttps://github.com/settings/security',
        bodyHtml: '',
        timestamp: '2026-11-16T17:01:00Z',
        unread: true,
        starred: false,
        archived: false,
        labels: ['INBOX', 'UNREAD'],
        headers: {},
      },
      {
        id: 'msg_2fa_2',
        threadId: 'th_2fa_2',
        accountId: 'acct_commerce',
        accountEmail: 'nick.shopping@gmail.com',
        fromName: 'Chase Fraud & Security',
        fromEmail: 'no-reply@alertsp.chase.com',
        toEmail: 'nick.shopping@gmail.com',
        subject: 'Your Chase temporary identification code',
        snippet: 'Your one-time passcode is 391048. It expires in 5 minutes.',
        bodyText:
          'Your one-time passcode is: 391048\nPlease enter this security code to verify your identity. This code expires in 5 minutes.',
        bodyHtml: '',
        timestamp: '2026-11-16T16:54:00Z',
        unread: true,
        starred: false,
        archived: false,
        labels: ['INBOX', 'UNREAD'],
        headers: {},
      },

      // 2. Orders & Packages
      {
        id: 'msg_order_1',
        threadId: 'th_order_1',
        accountId: 'acct_commerce',
        accountEmail: 'nick.shopping@gmail.com',
        fromName: 'Amazon.com',
        fromEmail: 'shipment-tracking@amazon.com',
        toEmail: 'nick.shopping@gmail.com',
        subject: 'Out for delivery today: Keychron Q1 Pro Wireless Custom Mechanical Keyboard',
        snippet: 'Your package with Keychron Q1 Pro is out for delivery today with Amazon Logistics TBA31094829104.',
        bodyText:
          'Order #114-8920411-3819402\nItem: Keychron Q1 Pro Wireless Custom Mechanical Keyboard\nStatus: Out for delivery\nArriving: Today by 8 PM\nTracking number: TBA31094829104\nTotal: $199.00',
        bodyHtml: '',
        timestamp: '2026-11-16T15:30:00Z',
        unread: true,
        starred: true,
        archived: false,
        labels: ['INBOX', 'UNREAD', 'STARRED'],
        headers: {},
      },
      {
        id: 'msg_order_2',
        threadId: 'th_order_2',
        accountId: 'acct_personal',
        accountEmail: 'nick.personal@gmail.com',
        fromName: 'B&H Photo Video',
        fromEmail: 'ord-status@bhphotovideo.com',
        toEmail: 'nick.personal@gmail.com',
        subject: 'Your B&H Order #1094827158 Has Shipped!',
        snippet: 'Good news! Your order has shipped via UPS tracking 1Z999AA10123456784. Arriving Thursday, Nov 19.',
        bodyText:
          'Order #1094827158\nItem: Elgato Stream Deck MK.2 & Sony 64GB SDXC UHS-II Card\nCarrier: UPS\nTracking number: 1Z999AA10123456784\nEstimated delivery: Thursday, Nov 19\nTotal: $184.95',
        bodyHtml: `<script type="application/ld+json">{"@context":"http://schema.org","@type":"Order","seller":{"name":"B&H Photo Video"},"orderNumber":"1094827158","price":"184.95","acceptedOffer":[{"itemOffered":{"name":"Elgato Stream Deck MK.2 + Sony 64GB UHS-II"}}]}</script>`,
        timestamp: '2026-11-16T13:15:00Z',
        unread: true,
        starred: false,
        archived: false,
        labels: ['INBOX', 'UNREAD'],
        headers: {},
      },
      {
        id: 'msg_order_3',
        threadId: 'th_order_3',
        accountId: 'acct_commerce',
        accountEmail: 'nick.shopping@gmail.com',
        fromName: 'Apple Store',
        fromEmail: 'no_reply@email.apple.com',
        toEmail: 'nick.shopping@gmail.com',
        subject: 'Your order W1294810293 has been delivered',
        snippet: 'Your package was delivered to your front desk/reception. Item: USB-C Woven Charge Cable (2m).',
        bodyText:
          'Order #W1294810293\nItem: 240W USB-C Charge Cable (2 m)\nStatus: Delivered\nCarrier: FedEx\nTracking number: 789102938471\nTotal: $29.00',
        bodyHtml: '',
        timestamp: '2026-11-15T21:10:00Z',
        unread: false,
        starred: false,
        archived: false,
        labels: ['INBOX'],
        headers: {},
      },

      // 3. Bills & Statements
      {
        id: 'msg_bill_1',
        threadId: 'th_bill_1',
        accountId: 'acct_commerce',
        accountEmail: 'nick.shopping@gmail.com',
        fromName: 'Chase Sapphire Reserve',
        fromEmail: 'no.reply.alerts@chase.com',
        toEmail: 'nick.shopping@gmail.com',
        subject: 'Your credit card statement is ready for account ending in 4821',
        snippet: 'Statement balance: $1,428.50. Payment due date: Nov 24, 2026. Minimum payment due: $40.00.',
        bodyText:
          'Your monthly credit card statement is ready for account ending in 4821.\nStatement Balance: $1,428.50\nMinimum Payment Due: $40.00\nPayment Due Date: Nov 24, 2026\nAutopay is off. Please review and schedule your payment at https://secure.chase.com',
        bodyHtml: '',
        timestamp: '2026-11-16T12:00:00Z',
        unread: true,
        starred: true,
        archived: false,
        labels: ['INBOX', 'UNREAD', 'STARRED'],
        headers: {},
      },
      {
        id: 'msg_bill_2',
        threadId: 'th_bill_2',
        accountId: 'acct_personal',
        accountEmail: 'nick.personal@gmail.com',
        fromName: 'Con Edison',
        fromEmail: 'myaccount@coned.com',
        toEmail: 'nick.personal@gmail.com',
        subject: 'Your Con Edison electric bill is ready — Autopay scheduled',
        snippet: 'Total amount due: $114.20 for account ending in 9012. Autopay scheduled for Nov 22, 2026.',
        bodyText:
          'Your monthly electric utility bill is ready for account ending in 9012.\nAmount Due: $114.20\nDue Date: Nov 22, 2026\nAutopay is enrolled and will automatically deduct on the due date.\nhttps://www.coned.com/en/accounts-billing',
        bodyHtml: '',
        timestamp: '2026-11-15T18:45:00Z',
        unread: true,
        starred: false,
        archived: false,
        labels: ['INBOX', 'UNREAD'],
        headers: {},
      },
      {
        id: 'msg_bill_3',
        threadId: 'th_bill_3',
        accountId: 'acct_commerce',
        accountEmail: 'nick.shopping@gmail.com',
        fromName: 'American Express',
        fromEmail: 'AmericanExpress@welcome.americanexpress.com',
        toEmail: 'nick.shopping@gmail.com',
        subject: 'Payment Reminder: Payment due soon for Gold Card ending in 3009',
        snippet: 'Your statement balance of $642.10 is due on Nov 19, 2026. Minimum payment due: $35.00.',
        bodyText:
          'Account ending in 3009\nAmount Due: $642.10\nMinimum Payment: $35.00\nDue Date: Nov 19, 2026\nAutopay is off. Pay online at https://global.americanexpress.com/dashboard',
        bodyHtml: '',
        timestamp: '2026-11-15T14:20:00Z',
        unread: true,
        starred: false,
        archived: false,
        labels: ['INBOX', 'UNREAD'],
        headers: {},
      },

      // 4. Events & Invitations
      {
        id: 'msg_event_1',
        threadId: 'th_event_1',
        accountId: 'acct_personal',
        accountEmail: 'nick.personal@gmail.com',
        fromName: 'Elena Vance',
        fromEmail: 'elena.vance@writersguild.org',
        toEmail: 'nick.personal@gmail.com',
        subject: 'Invitation: Sci-Fi Worldbuilding & Map-Forge Sync @ Wed Nov 18, 2026 7pm - 8pm (EST)',
        snippet: 'You have been invited to Sci-Fi Worldbuilding & Map-Forge Sync. Join with Google Meet.',
        bodyText:
          'When: Wed Nov 18, 2026 7:00pm – 8:00pm EST\nWhere: https://meet.google.com/kqx-vbnm-pqr\nOrganizer: Elena Vance\nNotes: Reviewing Libertopolis map districts and BYM chapter outline.',
        bodyHtml: '',
        timestamp: '2026-11-16T14:10:00Z',
        unread: true,
        starred: false,
        archived: false,
        labels: ['INBOX', 'UNREAD'],
        headers: { 'content-type': 'text/calendar; charset="UTF-8"; method=REQUEST' },
      },
      {
        id: 'msg_event_2',
        threadId: 'th_event_2',
        accountId: 'acct_dev',
        accountEmail: 'fleker.dev@gmail.com',
        fromName: 'Luma Events',
        fromEmail: 'support@lu.ma',
        toEmail: 'fleker.dev@gmail.com',
        subject: 'Invitation: NYC Local-First & Obsidian Plugin Builders Night @ Thu Nov 19, 2026 6:30pm',
        snippet: 'RSVP confirmed for NYC Local-First & Obsidian Plugin Builders Night in SoHo, NYC.',
        bodyText:
          'When: Thu Nov 19, 2026 6:30pm – 9:00pm EST\nWhere: Betaworks Studios, 29 Little West 12th St, New York, NY\nLink: https://lu.ma/nyc-obsidian-builders\nBring a 3-minute demo of your favorite plugin or local tool!',
        bodyHtml: '',
        timestamp: '2026-11-15T19:00:00Z',
        unread: true,
        starred: false,
        archived: false,
        labels: ['INBOX', 'UNREAD'],
        headers: {},
      },

      // 5. Notifications (GitHub, CI/CD)
      {
        id: 'msg_notif_1',
        threadId: 'th_notif_1',
        accountId: 'acct_dev',
        accountEmail: 'fleker.dev@gmail.com',
        fromName: 'maya-lin (via GitHub)',
        fromEmail: 'notifications@github.com',
        toEmail: 'fleker.dev@gmail.com',
        subject: '[fleker/feedly-for-obsidian] feat: Add tag frontmatter mapping for unread articles (#42)',
        snippet: '@maya-lin requested your review on PR #42 in fleker/feedly-for-obsidian.',
        bodyText:
          '@maya-lin requested your review on: fleker/feedly-for-obsidian#42\nAdds custom YAML frontmatter tag arrays when syncing saved Feedly boards.\nView Pull Request: https://github.com/fleker/feedly-for-obsidian/pull/42',
        bodyHtml: '',
        timestamp: '2026-11-16T16:20:00Z',
        unread: true,
        starred: false,
        archived: false,
        labels: ['INBOX', 'UNREAD'],
        headers: { 'x-github-sender': 'maya-lin' },
      },
      {
        id: 'msg_notif_2',
        threadId: 'th_notif_2',
        accountId: 'acct_dev',
        accountEmail: 'fleker.dev@gmail.com',
        fromName: 'GitHub Actions',
        fromEmail: 'notifications@github.com',
        toEmail: 'fleker.dev@gmail.com',
        subject: '[fleker/feedly-for-obsidian] Run failed: Release Build & Unit Tests - main (#41)',
        snippet: 'Workflow Release Build & Unit Tests failed on branch main.',
        bodyText:
          'Run failed for workflow: Release Build & Unit Tests on main (#41).\nhttps://github.com/fleker/feedly-for-obsidian/actions/runs/918273645',
        bodyHtml: '',
        timestamp: '2026-11-16T15:05:00Z',
        unread: true,
        starred: false,
        archived: false,
        labels: ['INBOX', 'UNREAD'],
        headers: { 'x-github-sender': 'github-actions[bot]' },
      },
      {
        id: 'msg_notif_3',
        threadId: 'th_notif_3',
        accountId: 'acct_dev',
        accountEmail: 'fleker.dev@gmail.com',
        fromName: 'dev-dan (via GitHub)',
        fromEmail: 'notifications@github.com',
        toEmail: 'fleker.dev@gmail.com',
        subject: '[fleker/novel-forge] Support Gemini 4 Carbon thinking level presets (#19)',
        snippet: 'Merged #19 into main. @fleker mentioned in commit.',
        bodyText:
          'Pull request #19 merged into main.\nhttps://github.com/fleker/novel-forge/pull/19',
        bodyHtml: '',
        timestamp: '2026-11-16T11:40:00Z',
        unread: false,
        starred: false,
        archived: false,
        labels: ['INBOX'],
        headers: { 'x-github-sender': 'dev-dan' },
      },

      // 6. Newsletters
      {
        id: 'msg_news_1',
        threadId: 'th_news_1',
        accountId: 'acct_personal',
        accountEmail: 'nick.personal@gmail.com',
        fromName: 'ByteByteGo Newsletter',
        fromEmail: 'bytebytego@substack.com',
        toEmail: 'nick.personal@gmail.com',
        subject: 'How Discord Stores Trillions of Messages & Why IMAP Struggles at Scale',
        snippet: 'Deep dive into modern message storage engines, JMAP vs IMAP protocol overhead, and stateless edge caching.',
        bodyText:
          'Legacy email protocols like IMAP (RFC 3501) were designed in 1986 for stateful folder synchronization over persistent TCP sockets.\n\n• When an account has dozens of labels, IMAP clients replicate full message bodies across multiple local mbox files.\n• Modern stateless APIs like the Gmail REST API and JMAP separate lightweight thread metadata queries from lazy MIME body fetching.\n• By storing only recent metadata and delegating full-text search to server-side indices, client memory drops by over 95%.\n\nRead the full architectural breakdown and diagrams on Substack.',
        bodyHtml: '',
        timestamp: '2026-11-16T11:00:00Z',
        unread: true,
        starred: true,
        archived: false,
        labels: ['INBOX', 'UNREAD', 'STARRED'],
        headers: {
          'list-unsubscribe': '<https://bytebytego.substack.com/action/disable_email>',
        },
      },
      {
        id: 'msg_news_2',
        threadId: 'th_news_2',
        accountId: 'acct_dev',
        accountEmail: 'fleker.dev@gmail.com',
        fromName: 'The Pragmatic Engineer',
        fromEmail: 'pragmaticengineer@substack.com',
        toEmail: 'fleker.dev@gmail.com',
        subject: 'Building Personal Software & Specialized Developer Tools in 2026',
        snippet: 'Why engineers are replacing bloated general-purpose desktop apps with custom workflow-tailored tools.',
        bodyText:
          'General-purpose desktop software has to serve 100 million users with every legacy edge case enabled.\n\n• Custom personal tools only need to implement the 20% of workflows you actually execute every day.\n• Category-specific UIs turn unstructured streams into actionable dashboards—like turning raw billing emails into a live payment ledger.\n• With Angular Signals and stateless REST APIs, a weekend prototype can outperform legacy native clients on startup latency.',
        bodyHtml: '',
        timestamp: '2026-11-15T16:00:00Z',
        unread: true,
        starred: false,
        archived: false,
        labels: ['INBOX', 'UNREAD'],
        headers: {
          'list-unsubscribe': '<https://newsletter.pragmaticengineer.com/unsubscribe>',
        },
      },

      // 7. Direct / Human Inbox
      {
        id: 'msg_inbox_1',
        threadId: 'th_inbox_1',
        accountId: 'acct_personal',
        accountEmail: 'nick.personal@gmail.com',
        fromName: 'Alex Rivera',
        fromEmail: 'alex.rivera@gmail.com',
        toEmail: 'nick.personal@gmail.com',
        subject: 'Tried out the Libertopolis export in Map-Forge!',
        snippet: 'Hey Nick — the new district lore drawer and SVG export worked great for our tabletop campaign.',
        bodyText:
          'Hey Nick,\n\nJust wanted to let you know I tried out the latest Map-Forge build last night. The district population modal and lore drawer worked super smoothly.\n\nAre you free this weekend to grab coffee in Brooklyn?\n\nBest,\nAlex',
        bodyHtml: '',
        timestamp: '2026-11-16T16:40:00Z',
        unread: true,
        starred: true,
        archived: false,
        labels: ['INBOX', 'UNREAD', 'STARRED'],
        headers: {},
      },
    ];
  }
}
