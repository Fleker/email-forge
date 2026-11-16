export type BuiltInCategoryId =
  | 'inbox'
  | 'two_factor'
  | 'orders'
  | 'bills'
  | 'events'
  | 'notifications'
  | 'newsletters';

export type CategoryId = BuiltInCategoryId | string;

export type CategoryViewTemplate =
  | 'unified_inbox'
  | 'two_factor_vault'
  | 'orders_tracker'
  | 'bills_ledger'
  | 'events_agenda'
  | 'notifications_rollup'
  | 'newsletters_reader'
  | 'custom_cards';

export interface GmailAccount {
  id: string;
  email: string;
  label: string;
  color: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  lastHistoryId?: string;
  isDemo?: boolean;
}

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface RawEmailMessage {
  id: string;
  threadId: string;
  accountId: string;
  accountEmail: string;
  fromName: string;
  fromEmail: string;
  toEmail: string;
  subject: string;
  snippet: string;
  bodyText: string;
  bodyHtml: string;
  timestamp: string;
  unread: boolean;
  starred: boolean;
  archived: boolean;
  labels: string[];
  headers: Record<string, string>;
}

export type OrderDeliveryStatus = 'Ordered' | 'Shipped' | 'Out for Delivery' | 'Delivered';

export interface OrderMetadata {
  merchant: string;
  orderNumber: string;
  carrier: 'UPS' | 'FedEx' | 'USPS' | 'Amazon' | 'DHL' | 'Other';
  trackingNumber?: string;
  trackingUrl?: string;
  status: OrderDeliveryStatus;
  estimatedDelivery?: string;
  totalAmount?: string;
  itemsSummary: string;
}

export interface NotificationMetadata {
  source: 'GitHub' | 'GitLab' | 'CI/CD' | 'Cloud' | 'Security' | 'System';
  repoOrProject: string;
  kind: 'PR' | 'Issue' | 'CI' | 'Release' | 'Mention' | 'Alert';
  referenceId?: string;
  statusBadge: string;
  actionUrl?: string;
}

export interface NewsletterMetadata {
  publication: string;
  author: string;
  estimatedReadMinutes: number;
  unsubscribeUrl?: string;
  keyTakeaways: string[];
}

export interface TwoFactorMetadata {
  serviceName: string;
  code: string;
  magicLinkUrl?: string;
  expiresInMinutes?: number;
}

export type BillPaymentStatus = 'Due Soon' | 'Overdue' | 'Autopay Scheduled' | 'Paid';

export interface BillMetadata {
  billerName: string;
  billType: 'Credit Card' | 'Utility' | 'Subscription' | 'Invoice';
  accountLast4?: string;
  amountDue: string;
  amountNumeric: number;
  dueDate: string;
  minimumPayment?: string;
  autopay: boolean;
  status: BillPaymentStatus;
  payUrl?: string;
}

export type EventRsvpStatus = 'Needs Action' | 'Accepted' | 'Tentative' | 'Declined';

export interface EventMetadata {
  eventTitle: string;
  organizer: string;
  startTime: string;
  endTime?: string;
  location: string;
  meetingUrl?: string;
  isVirtual: boolean;
  rsvpStatus: EventRsvpStatus;
}

export interface CategorizedEmail {
  raw: RawEmailMessage;
  categoryId: CategoryId;
  orderMeta?: OrderMetadata;
  notificationMeta?: NotificationMetadata;
  newsletterMeta?: NewsletterMetadata;
  twoFactorMeta?: TwoFactorMetadata;
  billMeta?: BillMetadata;
  eventMeta?: EventMetadata;
  customMeta?: Record<string, string>;
}

export interface CustomCategoryRule {
  id: string;
  label: string;
  icon: string;
  badgeColor: string;
  description: string;
  senderKeywords: string[];
  subjectKeywords: string[];
  bodyKeywords: string[];
  extractRegex?: string;
  extractLabel?: string;
}

export interface CategoryPlugin {
  id: CategoryId;
  label: string;
  icon: string;
  badgeColor: string;
  description: string;
  priority: number;
  viewTemplate: CategoryViewTemplate;
  isCustom?: boolean;
  customRule?: CustomCategoryRule;
  match: (email: RawEmailMessage) => boolean;
  enrich: (email: RawEmailMessage) => Partial<CategorizedEmail>;
}

export type ComposeMode = 'new' | 'reply' | 'forward';

export interface OutboundEmailRequest {
  mode: ComposeMode;
  fromAccountId: string;
  to: string;
  cc?: string;
  subject: string;
  body: string;
  originalEmail?: CategorizedEmail;
}

export interface SentEmailRecord {
  id: string;
  mode: ComposeMode;
  fromAccountId: string;
  fromEmail: string;
  to: string;
  cc?: string;
  subject: string;
  body: string;
  threadId?: string;
  sentAt: string;
}

