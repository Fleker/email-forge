import { Injectable, signal, computed } from '@angular/core';
import {
  BillMetadata,
  BillPaymentStatus,
  CategorizedEmail,
  CategoryId,
  CategoryPlugin,
  CustomCategoryRule,
  EventMetadata,
  NewsletterMetadata,
  NotificationMetadata,
  OrderDeliveryStatus,
  OrderMetadata,
  RawEmailMessage,
  TwoFactorMetadata,
} from '../models/mail.model';

const CUSTOM_CATEGORIES_STORAGE_KEY = 'mail_forge_custom_categories';

@Injectable({
  providedIn: 'root',
})
export class CategoryRegistryService {
  private readonly builtInPlugins: CategoryPlugin[] = [
    this.createTwoFactorPlugin(),
    this.createOrdersPlugin(),
    this.createBillsPlugin(),
    this.createEventsPlugin(),
    this.createNotificationsPlugin(),
    this.createNewslettersPlugin(),
  ];

  readonly customRules = signal<CustomCategoryRule[]>(this.loadCustomRules());

  readonly plugins = computed<CategoryPlugin[]>(() => {
    const dynamicPlugins = this.customRules().map((rule) =>
      this.createCustomRulePlugin(rule)
    );
    return [...this.builtInPlugins, ...dynamicPlugins].sort(
      (a, b) => b.priority - a.priority
    );
  });

  categorize(raw: RawEmailMessage): CategorizedEmail {
    for (const plugin of this.plugins()) {
      if (plugin.match(raw)) {
        return {
          raw,
          categoryId: plugin.id,
          ...plugin.enrich(raw),
        };
      }
    }
    return {
      raw,
      categoryId: 'inbox',
    };
  }

  registerCustomCategory(rule: CustomCategoryRule): void {
    const sanitizedId = rule.id
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '_');
    const normalized: CustomCategoryRule = {
      ...rule,
      id: sanitizedId || `custom_${Date.now()}`,
      senderKeywords: rule.senderKeywords.map((k) => k.trim().toLowerCase()).filter(Boolean),
      subjectKeywords: rule.subjectKeywords.map((k) => k.trim().toLowerCase()).filter(Boolean),
      bodyKeywords: rule.bodyKeywords.map((k) => k.trim().toLowerCase()).filter(Boolean),
    };

    const updated = [
      ...this.customRules().filter((r) => r.id !== normalized.id),
      normalized,
    ];
    this.customRules.set(updated);
    this.saveCustomRules(updated);
  }

  removeCustomCategory(id: CategoryId): void {
    const updated = this.customRules().filter((r) => r.id !== id);
    this.customRules.set(updated);
    this.saveCustomRules(updated);
  }

  getPlugin(id: CategoryId): CategoryPlugin | undefined {
    return this.plugins().find((p) => p.id === id);
  }

  private loadCustomRules(): CustomCategoryRule[] {
    try {
      const raw = localStorage.getItem(CUSTOM_CATEGORIES_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private saveCustomRules(rules: CustomCategoryRule[]): void {
    try {
      localStorage.setItem(CUSTOM_CATEGORIES_STORAGE_KEY, JSON.stringify(rules));
    } catch {
      // Ignore storage quota errors in restricted environments
    }
  }

  private createCustomRulePlugin(rule: CustomCategoryRule): CategoryPlugin {
    return {
      id: rule.id,
      label: rule.label,
      icon: rule.icon || 'label',
      badgeColor: rule.badgeColor || '#6366f1',
      description: rule.description || 'Custom user-defined email category',
      priority: 75,
      viewTemplate: 'custom_cards',
      isCustom: true,
      customRule: rule,
      match: (email: RawEmailMessage) => {
        const senderHaystack = `${email.fromName} ${email.fromEmail}`.toLowerCase();
        const subjectHaystack = email.subject.toLowerCase();
        const bodyHaystack = `${email.snippet} ${email.bodyText}`.toLowerCase();

        const senderHit =
          rule.senderKeywords.length > 0 &&
          rule.senderKeywords.some((kw) => senderHaystack.includes(kw));
        const subjectHit =
          rule.subjectKeywords.length > 0 &&
          rule.subjectKeywords.some((kw) => subjectHaystack.includes(kw));
        const bodyHit =
          rule.bodyKeywords.length > 0 &&
          rule.bodyKeywords.some((kw) => bodyHaystack.includes(kw));

        return senderHit || subjectHit || bodyHit;
      },
      enrich: (email: RawEmailMessage) => {
        const customMeta: Record<string, string> = {};
        if (rule.extractRegex) {
          try {
            const regex = new RegExp(rule.extractRegex, 'i');
            const match = `${email.subject}\n${email.bodyText}`.match(regex);
            if (match) {
              customMeta[rule.extractLabel || 'Extracted'] = match[1] || match[0];
            }
          } catch {
            // Invalid user regex ignored gracefully
          }
        }
        return { customMeta };
      },
    };
  }

  private createTwoFactorPlugin(): CategoryPlugin {
    return {
      id: 'two_factor',
      label: '2FA & Codes',
      icon: 'key',
      badgeColor: '#dc2626',
      description: 'Verification codes, OTP tokens, and magic sign-in links',
      priority: 100,
      viewTemplate: 'two_factor_vault',
      match: (email: RawEmailMessage) => {
        const combined = `${email.subject} ${email.snippet} ${email.bodyText}`;
        const hasKeyword =
          /\b(verification code|security code|login code|one-time passcode|two-factor|2fa|sign-in code|authentication code|verify your identity|confirm your sign-in)\b/i.test(
            combined
          );
        const hasCode = /\b(\d{6,8}|[A-Z0-9]{3}-[A-Z0-9]{3})\b/.test(combined);
        return hasKeyword && hasCode;
      },
      enrich: (email: RawEmailMessage) => {
        const combined = `${email.subject}\n${email.bodyText || email.snippet}`;
        const codeMatch =
          combined.match(/(?:code|passcode|token|pin)\s*(?:is|:)?\s*\b(\d{6,8}|[A-Z0-9]{3}-[A-Z0-9]{3})\b/i) ||
          combined.match(/\b(\d{6,8}|[A-Z0-9]{3}-[A-Z0-9]{3})\b/);
        const expMatch = combined.match(/expires?\s+in\s+(\d+)\s*minutes?/i);
        const urlMatch = combined.match(/https?:\/\/[^\s"'<>]+/i);

        const twoFactorMeta: TwoFactorMetadata = {
          serviceName: this.cleanSenderBrand(email.fromName, email.fromEmail),
          code: codeMatch ? codeMatch[1] : '------',
          magicLinkUrl: urlMatch ? urlMatch[0] : undefined,
          expiresInMinutes: expMatch ? parseInt(expMatch[1], 10) : 10,
        };
        return { twoFactorMeta };
      },
    };
  }

  private createOrdersPlugin(): CategoryPlugin {
    return {
      id: 'orders',
      label: 'Orders & Packages',
      icon: 'local_shipping',
      badgeColor: '#0284c7',
      description: 'Order confirmations, shipment tracking, and delivery status',
      priority: 90,
      viewTemplate: 'orders_tracker',
      match: (email: RawEmailMessage) => {
        if (/"@type"\s*:\s*"(Order|ParcelDelivery)"/i.test(email.bodyHtml)) {
          return true;
        }
        const subject = email.subject.toLowerCase();
        const combined = `${email.subject} ${email.snippet}`.toLowerCase();
        const orderSubjectPattern =
          /\b(order confirmed|your order|has shipped|out for delivery|delivered|shipment|tracking number|package from|dispatch confirmation)\b/i;
        const trackingIdPattern = /\b(1Z[A-Z0-9]{16}|TBA\d{10,15})\b/;
        return orderSubjectPattern.test(subject) || trackingIdPattern.test(combined);
      },
      enrich: (email: RawEmailMessage) => {
        const combined = `${email.subject}\n${email.bodyText}\n${email.snippet}`;
        const jsonLdOrder = this.extractSchemaOrgJsonLd(email.bodyHtml);

        const orderNumMatch =
          combined.match(/order\s*(?:#|number|id)?\s*[:#]?\s*([A-Z0-9-]{5,24})/i) ||
          combined.match(/#(\d{3}-\d{7}-\d{7}|\d{5,15})/);
        const upsMatch = combined.match(/\b(1Z[A-Z0-9]{16})\b/);
        const amazonMatch = combined.match(/\b(TBA\d{10,15})\b/);
        const genericTrackingMatch = combined.match(
          /tracking\s*(?:#|number|id)?\s*[:#]?\s*([A-Z0-9]{9,24})\b/i
        );

        let carrier: OrderMetadata['carrier'] = 'Other';
        let trackingNumber = jsonLdOrder?.trackingNumber;
        if (upsMatch) {
          carrier = 'UPS';
          trackingNumber = upsMatch[1];
        } else if (amazonMatch) {
          carrier = 'Amazon';
          trackingNumber = amazonMatch[1];
        } else if (/\bfedex\b/i.test(combined)) {
          carrier = 'FedEx';
          trackingNumber = trackingNumber || genericTrackingMatch?.[1];
        } else if (/\busps\b/i.test(combined)) {
          carrier = 'USPS';
          trackingNumber = trackingNumber || genericTrackingMatch?.[1];
        } else if (/\bdhl\b/i.test(combined)) {
          carrier = 'DHL';
          trackingNumber = trackingNumber || genericTrackingMatch?.[1];
        } else if (genericTrackingMatch) {
          trackingNumber = genericTrackingMatch[1];
        }

        let status: OrderDeliveryStatus = 'Ordered';
        if (/\bdelivered\b/i.test(email.subject) || /\bhas been delivered\b/i.test(combined)) {
          status = 'Delivered';
        } else if (/\bout for delivery\b/i.test(combined)) {
          status = 'Out for Delivery';
        } else if (/\b(shipped|in transit|on the way|dispatched)\b/i.test(combined) || trackingNumber) {
          status = 'Shipped';
        }

        const etaMatch = combined.match(
          /(?:arriving|estimated delivery|expected delivery|delivers?)\s*(?:by|on|:)?\s*([A-Za-z]+(?:,\s*[A-Za-z]+\s+\d{1,2})?|\b(?:Today|Tomorrow)\b)/i
        );
        const totalMatch = combined.match(/(?:total|amount)\s*:?\s*(\$\d[\d,]*\.\d{2})/i) ||
          combined.match(/(\$\d[\d,]*\.\d{2})/);
        const itemMatch = combined.match(/(?:item|product|contents?)\s*:?\s*([^\n\r.]{4,70})/i);

        const orderMeta: OrderMetadata = {
          merchant: jsonLdOrder?.merchant || this.cleanSenderBrand(email.fromName, email.fromEmail),
          orderNumber: jsonLdOrder?.orderNumber || (orderNumMatch ? orderNumMatch[1] : `ORD-${email.id.slice(-6).toUpperCase()}`),
          carrier,
          trackingNumber,
          trackingUrl: jsonLdOrder?.trackingUrl || this.buildCarrierTrackingUrl(carrier, trackingNumber),
          status,
          estimatedDelivery: etaMatch ? etaMatch[1].trim() : status === 'Delivered' ? 'Delivered' : 'In Transit',
          totalAmount: jsonLdOrder?.totalAmount || (totalMatch ? totalMatch[1] : undefined),
          itemsSummary: jsonLdOrder?.itemsSummary || (itemMatch ? itemMatch[1].trim() : email.subject),
        };
        return { orderMeta };
      },
    };
  }

  private createBillsPlugin(): CategoryPlugin {
    return {
      id: 'bills',
      label: 'Bills & Statements',
      icon: 'receipt_long',
      badgeColor: '#059669',
      description: 'Credit card statements, utility bills, and payment due reminders',
      priority: 85,
      viewTemplate: 'bills_ledger',
      match: (email: RawEmailMessage) => {
        const combined = `${email.subject} ${email.snippet} ${email.bodyText}`;
        return /\b(statement is ready|payment due|bill is ready|amount due|minimum payment|autopay scheduled|credit card statement|monthly statement|upcoming payment|utility bill|invoice due)\b/i.test(
          combined
        );
      },
      enrich: (email: RawEmailMessage) => {
        const combined = `${email.subject}\n${email.bodyText}\n${email.snippet}`;
        const amountMatch =
          combined.match(/(?:amount due|statement balance|new balance|total due|payment amount)\s*:?\s*\$(\d[\d,]*\.\d{2})/i) ||
          combined.match(/\$(\d[\d,]*\.\d{2})/);
        const dueMatch = combined.match(
          /(?:due date|payment due|due on|due by|scheduled for)\s*:?\s*([A-Za-z]+\s+\d{1,2}(?:,\s*\d{4})?|\d{1,2}\/\d{1,2}\/\d{2,4})/i
        );
        const minMatch = combined.match(/minimum payment\s*(?:due)?\s*:?\s*(\$\d[\d,]*\.\d{2})/i);
        const last4Match = combined.match(/(?:ending in|account|card)\s*(?:\.{2,}|x+|\*|-)?\s*(\d{4})\b/i);
        const autopay = /\b(autopay|automatic payment|auto-pay)\b/i.test(combined) && !/\bautopay is off\b/i.test(combined);

        let status: BillPaymentStatus = 'Due Soon';
        if (/\b(payment received|thank you for your payment|paid in full)\b/i.test(combined)) {
          status = 'Paid';
        } else if (/\b(past due|overdue|late)\b/i.test(combined)) {
          status = 'Overdue';
        } else if (autopay) {
          status = 'Autopay Scheduled';
        }

        let billType: BillMetadata['billType'] = 'Credit Card';
        if (/\b(electric|water|gas|internet|fios|fiber|con edison|utility)\b/i.test(combined)) {
          billType = 'Utility';
        } else if (/\b(invoice)\b/i.test(combined)) {
          billType = 'Invoice';
        } else if (/\b(subscription|membership|cloud)\b/i.test(combined)) {
          billType = 'Subscription';
        }

        const rawAmount = amountMatch ? amountMatch[1] : '0.00';
        const numeric = parseFloat(rawAmount.replace(/,/g, '')) || 0;
        const urlMatch = combined.match(/https?:\/\/[^\s"'<>]+/i);

        const billMeta: BillMetadata = {
          billerName: this.cleanSenderBrand(email.fromName, email.fromEmail),
          billType,
          accountLast4: last4Match ? last4Match[1] : undefined,
          amountDue: `$${rawAmount}`,
          amountNumeric: numeric,
          dueDate: dueMatch ? dueMatch[1] : 'Upcoming',
          minimumPayment: minMatch ? minMatch[1] : undefined,
          autopay,
          status,
          payUrl: urlMatch ? urlMatch[0] : undefined,
        };
        return { billMeta };
      },
    };
  }

  private createEventsPlugin(): CategoryPlugin {
    return {
      id: 'events',
      label: 'Events & Invites',
      icon: 'event',
      badgeColor: '#7c3aed',
      description: 'Calendar invitations, RSVPs, Luma/Eventbrite tickets, and meetings',
      priority: 80,
      viewTemplate: 'events_agenda',
      match: (email: RawEmailMessage) => {
        const contentType = (email.headers['content-type'] || '').toLowerCase();
        if (contentType.includes('text/calendar')) {
          return true;
        }
        const subject = email.subject;
        const from = email.fromEmail.toLowerCase();
        if (
          /^(invitation|updated invitation|canceled event|accepted|tentative):/i.test(subject) ||
          from.includes('calendar-notification@google.com') ||
          from.includes('lu.ma') ||
          from.includes('eventbrite.com') ||
          from.includes('meetup.com')
        ) {
          return true;
        }
        const combined = `${email.subject}\n${email.bodyText}`;
        return /\b(rsvp|add to calendar|meet\.google\.com\/[a-z-]+)\b/i.test(combined) && /\bwhen\s*:/i.test(combined);
      },
      enrich: (email: RawEmailMessage) => {
        const combined = `${email.subject}\n${email.bodyText}\n${email.snippet}`;
        const cleanedSubject = email.subject
          .replace(/^(invitation|updated invitation|accepted|tentative):\s*/i, '')
          .split('@')[0]
          .trim();

        const subjectWhenMatch = email.subject.match(/@\s*([^()]+?)(?:\s*\([^)]+\))?$/);
        const bodyWhenMatch = combined.match(/when\s*:\s*([^\n\r]+)/i);
        const whereMatch = combined.match(/where\s*:\s*([^\n\r]+)/i);
        const meetMatch = combined.match(/https?:\/\/(?:meet\.google\.com\/[a-z-]+|[^\s"'<>]*zoom\.us\/j\/[^\s"'<>]+|lu\.ma\/[^\s"'<>]+)/i);

        const location = whereMatch
          ? whereMatch[1].trim()
          : meetMatch
          ? meetMatch[0]
          : 'Online / See Invite';

        const eventMeta: EventMetadata = {
          eventTitle: cleanedSubject || email.subject,
          organizer: email.fromName || email.fromEmail,
          startTime: subjectWhenMatch
            ? subjectWhenMatch[1].trim()
            : bodyWhenMatch
            ? bodyWhenMatch[1].trim()
            : 'Upcoming',
          location,
          meetingUrl: meetMatch ? meetMatch[0] : undefined,
          isVirtual: Boolean(meetMatch || /meet\.google|zoom\.us|virtual|online/i.test(location)),
          rsvpStatus: /^accepted:/i.test(email.subject)
            ? 'Accepted'
            : /^tentative:/i.test(email.subject)
            ? 'Tentative'
            : 'Needs Action',
        };
        return { eventMeta };
      },
    };
  }

  private createNotificationsPlugin(): CategoryPlugin {
    return {
      id: 'notifications',
      label: 'Notifications',
      icon: 'notifications_active',
      badgeColor: '#d97706',
      description: 'GitHub PRs, Issues, CI/CD runs, and automated developer alerts',
      priority: 70,
      viewTemplate: 'notifications_rollup',
      match: (email: RawEmailMessage) => {
        const from = email.fromEmail.toLowerCase();
        const hasGhHeader = Boolean(email.headers['x-github-sender'] || email.headers['x-gitlab-project']);
        const isDevSender =
          from.includes('notifications@github.com') ||
          from.includes('noreply@github.com') ||
          from.includes('gitlab.com') ||
          from.includes('sentry.io') ||
          from.includes('vercel.com') ||
          from.includes('circleci.com') ||
          from.includes('linear.app') ||
          from.includes(' Dependabot');
        const hasRepoBracket = /^\[(?:Re:\s*)?[\w.-]+\/[\w.-]+\]/i.test(email.subject);
        return hasGhHeader || isDevSender || hasRepoBracket;
      },
      enrich: (email: RawEmailMessage) => {
        const combined = `${email.subject}\n${email.bodyText}\n${email.snippet}`;
        const repoMatch = email.subject.match(/\[([\w.-]+\/[\w.-]+)\]/);
        const refMatch = email.subject.match(/\(#(\d+)\)|#(\d+)/);
        const urlMatch = combined.match(/https?:\/\/(?:github\.com|gitlab\.com|[^\s"'<>]+)\/[^\s"'<>]+/i);

        let kind: NotificationMetadata['kind'] = 'Alert';
        let statusBadge = 'Update';
        if (/\b(pull request|pr|review requested|merged)\b/i.test(combined) || /\/pull\//i.test(combined)) {
          kind = 'PR';
          statusBadge = /\bmerged\b/i.test(combined)
            ? 'Merged'
            : /\breview requested\b/i.test(combined)
            ? 'Review Requested'
            : 'PR Active';
        } else if (/\b(workflow|ci|build|run failed|checks failed|pipeline)\b/i.test(combined)) {
          kind = 'CI';
          statusBadge = /\bfailed\b/i.test(combined) ? 'CI Failed' : 'CI Passed';
        } else if (/\b(release|published|tag)\b/i.test(combined)) {
          kind = 'Release';
          statusBadge = 'New Release';
        } else if (/\b(mentioned you|@fleker)\b/i.test(combined)) {
          kind = 'Mention';
          statusBadge = 'Mentioned';
        } else if (/\/issues\//i.test(combined) || /\bissue\b/i.test(combined)) {
          kind = 'Issue';
          statusBadge = 'Issue';
        }

        const from = email.fromEmail.toLowerCase();
        const source: NotificationMetadata['source'] = from.includes('github')
          ? 'GitHub'
          : from.includes('gitlab')
          ? 'GitLab'
          : kind === 'CI'
          ? 'CI/CD'
          : 'System';

        const notificationMeta: NotificationMetadata = {
          source,
          repoOrProject: repoMatch ? repoMatch[1] : this.cleanSenderBrand(email.fromName, email.fromEmail),
          kind,
          referenceId: refMatch ? `#${refMatch[1] || refMatch[2]}` : undefined,
          statusBadge,
          actionUrl: urlMatch ? urlMatch[0] : undefined,
        };
        return { notificationMeta };
      },
    };
  }

  private createNewslettersPlugin(): CategoryPlugin {
    return {
      id: 'newsletters',
      label: 'Newsletters',
      icon: 'newspaper',
      badgeColor: '#2563eb',
      description: 'Substack, Medium, digests, and long-form reading with 1-click Archive & Forward',
      priority: 60,
      viewTemplate: 'newsletters_reader',
      match: (email: RawEmailMessage) => {
        const hasUnsubscribe = Boolean(email.headers['list-unsubscribe']);
        const from = `${email.fromName} ${email.fromEmail}`.toLowerCase();
        const isNewsletterDomain =
          from.includes('substack.com') ||
          from.includes('medium.com') ||
          from.includes('beehiiv.com') ||
          from.includes('buttondown.email') ||
          from.includes('tldrnewsletter.com') ||
          from.includes('newsletter') ||
          from.includes('digest') ||
          from.includes('weekly');
        return hasUnsubscribe || isNewsletterDomain;
      },
      enrich: (email: RawEmailMessage) => {
        const text = email.bodyText || email.snippet;
        const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
        const estimatedReadMinutes = Math.max(1, Math.round(wordCount / 180));

        const unsubHeader = email.headers['list-unsubscribe'] || '';
        const unsubMatch = unsubHeader.match(/<(https?:\/\/[^>]+)>/i) ||
          text.match(/https?:\/\/[^\s"'<>]*unsubscribe[^\s"'<>]*/i);

        const sentences = text
          .split(/(?:[\n\r]+|(?<=[.!?])\s+)/)
          .map((s) => s.replace(/^[•*-]\s*/, '').trim())
          .filter((s) => s.length >= 28 && s.length <= 160)
          .slice(0, 3);

        const newsletterMeta: NewsletterMetadata = {
          publication: this.cleanSenderBrand(email.fromName, email.fromEmail),
          author: email.fromEmail,
          estimatedReadMinutes,
          unsubscribeUrl: unsubMatch ? unsubMatch[1] || unsubMatch[0] : undefined,
          keyTakeaways: sentences.length > 0 ? sentences : [email.snippet],
        };
        return { newsletterMeta };
      },
    };
  }

  private extractSchemaOrgJsonLd(html: string): Partial<OrderMetadata> | null {
    if (!html) return null;
    const match = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!match) return null;
    try {
      const data = JSON.parse(match[1].trim());
      const node = Array.isArray(data) ? data[0] : data;
      if (!node) return null;
      return {
        merchant: node.seller?.name || node.provider?.name,
        orderNumber: node.orderNumber || node.partOfOrder?.orderNumber,
        trackingNumber: node.trackingNumber,
        trackingUrl: node.trackingUrl,
        totalAmount: node.price ? `$${node.price}` : undefined,
        itemsSummary: node.acceptedOffer?.[0]?.itemOffered?.name || node.itemShipped?.name,
      };
    } catch {
      return null;
    }
  }

  private buildCarrierTrackingUrl(
    carrier: OrderMetadata['carrier'],
    trackingNumber?: string
  ): string | undefined {
    if (!trackingNumber) return undefined;
    switch (carrier) {
      case 'UPS':
        return `https://www.ups.com/track?tracknum=${encodeURIComponent(trackingNumber)}`;
      case 'FedEx':
        return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(trackingNumber)}`;
      case 'USPS':
        return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(trackingNumber)}`;
      default:
        return `https://www.google.com/search?q=${encodeURIComponent(trackingNumber)}`;
    }
  }

  private cleanSenderBrand(fromName: string, fromEmail: string): string {
    const cleaned = (fromName || '')
      .replace(/["'<>]/g, '')
      .replace(/\s*\(via .*\)$/i, '')
      .trim();
    if (cleaned) return cleaned;
    const domain = (fromEmail.split('@')[1] || fromEmail).split('.')[0];
    return domain ? domain.charAt(0).toUpperCase() + domain.slice(1) : 'Unknown';
  }
}
