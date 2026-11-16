import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatBadgeModule } from '@angular/material/badge';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDividerModule } from '@angular/material/divider';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import {
  CategorizedEmail,
  CategoryId,
  CategoryViewTemplate,
  CustomCategoryRule,
  EventRsvpStatus,
  GmailAccount,
  OrderDeliveryStatus,
} from './models/mail.model';
import { CategoryRegistryService } from './services/category-registry.service';
import { GmailApiService } from './services/gmail-api.service';

export interface NotificationRepoGroup {
  repoOrProject: string;
  items: CategorizedEmail[];
  unreadCount: number;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatToolbarModule,
    MatButtonModule,
    MatIconModule,
    MatCardModule,
    MatChipsModule,
    MatBadgeModule,
    MatFormFieldModule,
    MatInputModule,
    MatExpansionModule,
    MatTooltipModule,
    MatDividerModule,
    MatSnackBarModule,
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit {
  readonly gmailService = inject(GmailApiService);
  readonly categoryRegistry = inject(CategoryRegistryService);
  private readonly snackBar = inject(MatSnackBar);

  // Navigation & filter state
  readonly selectedAccountId = signal<string>('all');
  readonly selectedCategoryId = signal<CategoryId>('all');
  readonly searchQuery = signal<string>('');
  readonly selectedEmailId = signal<string | null>(null);

  // Modals state
  readonly showOAuthModal = signal<boolean>(false);
  readonly showAddCategoryModal = signal<boolean>(false);
  readonly forwardingEmail = signal<CategorizedEmail | null>(null);

  // Forward modal fields
  readonly forwardTo = signal<string>('');
  readonly forwardNote = signal<string>('');
  readonly forwardArchiveAfter = signal<boolean>(true);

  // OAuth form fields
  readonly oauthClientId = signal<string>('');
  readonly oauthClientSecret = signal<string>('');
  readonly oauthRedirectUri = signal<string>('');
  readonly oauthLoginHint = signal<string>('');

  // New Custom Category form fields
  readonly newCatLabel = signal<string>('');
  readonly newCatIcon = signal<string>('bookmark');
  readonly newCatColor = signal<string>('#6366f1');
  readonly newCatDescription = signal<string>('');
  readonly newCatSenders = signal<string>('');
  readonly newCatSubjects = signal<string>('');
  readonly newCatBodies = signal<string>('');
  readonly newCatRegex = signal<string>('');
  readonly newCatRegexLabel = signal<string>('Reference');

  // Local RSVP state overrides for events
  readonly rsvpOverrides = signal<Record<string, EventRsvpStatus>>({});

  readonly accounts = this.gmailService.accounts;
  readonly plugins = this.categoryRegistry.plugins;

  // Emails filtered by Account + Search Query (used to compute category badge counts)
  readonly accountAndSearchFilteredEmails = computed<CategorizedEmail[]>(() => {
    const acctId = this.selectedAccountId();
    const q = this.searchQuery().trim().toLowerCase();

    return this.gmailService.categorizedEmails().filter((item) => {
      if (acctId !== 'all' && item.raw.accountId !== acctId) {
        return false;
      }
      if (!q) return true;
      const haystack = [
        item.raw.subject,
        item.raw.fromName,
        item.raw.fromEmail,
        item.raw.snippet,
        item.raw.bodyText,
        item.orderMeta?.trackingNumber || '',
        item.orderMeta?.orderNumber || '',
        item.billMeta?.billerName || '',
        item.notificationMeta?.repoOrProject || '',
        item.twoFactorMeta?.code || '',
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  });

  // Emails in the currently selected category
  readonly activeEmails = computed<CategorizedEmail[]>(() => {
    const catId = this.selectedCategoryId();
    const list = this.accountAndSearchFilteredEmails();
    if (catId === 'all') {
      return list;
    }
    return list.filter((item) => item.categoryId === catId);
  });

  // Unread 2FA codes across the currently selected account filter (for top floating banner)
  readonly activeTwoFactorCodes = computed<CategorizedEmail[]>(() => {
    return this.accountAndSearchFilteredEmails().filter(
      (item) => item.categoryId === 'two_factor' && item.raw.unread
    );
  });

  // Category counts for left sidebar
  readonly categoryCounts = computed<Record<string, number>>(() => {
    const counts: Record<string, number> = {
      all: 0,
      inbox: 0,
    };
    for (const plugin of this.plugins()) {
      counts[plugin.id] = 0;
    }
    for (const item of this.accountAndSearchFilteredEmails()) {
      counts['all'] = (counts['all'] || 0) + 1;
      counts[item.categoryId] = (counts[item.categoryId] || 0) + 1;
    }
    return counts;
  });

  // Unread counts per account for top switcher pills
  readonly accountCounts = computed<Record<string, number>>(() => {
    const counts: Record<string, number> = { all: 0 };
    for (const item of this.gmailService.categorizedEmails()) {
      counts['all'] = (counts['all'] || 0) + 1;
      counts[item.raw.accountId] = (counts[item.raw.accountId] || 0) + 1;
    }
    return counts;
  });

  // Active view template based on selected category
  readonly activeViewTemplate = computed<CategoryViewTemplate>(() => {
    const catId = this.selectedCategoryId();
    if (catId === 'all' || catId === 'inbox') {
      return 'unified_inbox';
    }
    const plugin = this.categoryRegistry.getPlugin(catId);
    return plugin?.viewTemplate || 'custom_cards';
  });

  // Grouped notifications by repository/project
  readonly notificationGroups = computed<NotificationRepoGroup[]>(() => {
    const items = this.activeEmails().filter(
      (e) => e.categoryId === 'notifications'
    );
    const map = new Map<string, CategorizedEmail[]>();
    for (const item of items) {
      const repo = item.notificationMeta?.repoOrProject || 'General';
      const arr = map.get(repo) || [];
      arr.push(item);
      map.set(repo, arr);
    }
    return Array.from(map.entries()).map(([repoOrProject, groupItems]) => ({
      repoOrProject,
      items: groupItems,
      unreadCount: groupItems.filter((i) => i.raw.unread).length,
    }));
  });

  // Currently selected newsletter for the split reader pane
  readonly selectedNewsletter = computed<CategorizedEmail | null>(() => {
    const newsletters = this.activeEmails().filter(
      (e) => e.categoryId === 'newsletters'
    );
    if (newsletters.length === 0) return null;
    const currentId = this.selectedEmailId();
    return (
      newsletters.find((n) => n.raw.id === currentId) || newsletters[0]
    );
  });

  // Orders summary KPIs
  readonly ordersSummary = computed(() => {
    const orders = this.activeEmails().filter((e) => e.categoryId === 'orders');
    const inTransit = orders.filter(
      (o) =>
        o.orderMeta?.status === 'Ordered' || o.orderMeta?.status === 'Shipped'
    ).length;
    const outForDelivery = orders.filter(
      (o) => o.orderMeta?.status === 'Out for Delivery'
    ).length;
    const delivered = orders.filter(
      (o) => o.orderMeta?.status === 'Delivered'
    ).length;
    return { total: orders.length, inTransit, outForDelivery, delivered };
  });

  // Bills summary KPIs
  readonly billsSummary = computed(() => {
    const bills = this.activeEmails().filter((e) => e.categoryId === 'bills');
    let totalDue = 0;
    let manualActionCount = 0;
    let autopayCount = 0;
    for (const b of bills) {
      const meta = b.billMeta;
      if (!meta || meta.status === 'Paid') continue;
      totalDue += meta.amountNumeric;
      if (meta.autopay) {
        autopayCount++;
      } else {
        manualActionCount++;
      }
    }
    return {
      totalDueFormatted: `$${totalDue.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`,
      manualActionCount,
      autopayCount,
    };
  });

  async ngOnInit(): Promise<void> {
    const cfg = this.gmailService.oauthConfig();
    this.oauthClientId.set(cfg.clientId);
    this.oauthClientSecret.set(cfg.clientSecret);
    this.oauthRedirectUri.set(cfg.redirectUri);

    try {
      const connected = await this.gmailService.handleOAuthCallbackIfPresent();
      if (connected) {
        this.notify(`Connected Gmail account ${connected.email}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.notify(`OAuth callback error: ${msg}`);
    }
  }

  selectAccount(accountId: string): void {
    this.selectedAccountId.set(accountId);
  }

  selectCategory(categoryId: CategoryId): void {
    this.selectedCategoryId.set(categoryId);
    this.selectedEmailId.set(null);
  }

  selectEmail(email: CategorizedEmail): void {
    this.selectedEmailId.set(email.raw.id);
    if (email.raw.unread) {
      this.gmailService.markAsRead(email.raw.id);
    }
  }

  getAccountForEmail(email: CategorizedEmail): GmailAccount | undefined {
    return this.accounts().find((a) => a.id === email.raw.accountId);
  }

  getPluginForCategory(categoryId: CategoryId) {
    return this.categoryRegistry.getPlugin(categoryId);
  }

  async copyCodeAndArchive(
    email: CategorizedEmail,
    event?: Event
  ): Promise<void> {
    event?.stopPropagation();
    const code = email.twoFactorMeta?.code || '';
    if (code && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(code);
      } catch {
        // Ignore clipboard errors in headless browser environments
      }
    }
    await this.gmailService.archiveEmail(email.raw.id);
    this.notify(
      `Copied 2FA code ${code} (${email.twoFactorMeta?.serviceName}) & archived`
    );
  }

  async copyTrackingNumber(trackingNumber: string, event?: Event): Promise<void> {
    event?.stopPropagation();
    if (navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(trackingNumber);
      } catch {
        // Ignore in headless tests
      }
    }
    this.notify(`Copied tracking number ${trackingNumber}`);
  }

  async archiveEmail(email: CategorizedEmail, event?: Event): Promise<void> {
    event?.stopPropagation();
    await this.gmailService.archiveEmail(email.raw.id);
    this.notify(`Archived "${email.raw.subject.slice(0, 42)}"`);
  }

  async toggleStar(email: CategorizedEmail, event?: Event): Promise<void> {
    event?.stopPropagation();
    await this.gmailService.toggleStar(email.raw.id);
  }

  async archiveDeliveredOrders(): Promise<void> {
    const deliveredIds = this.activeEmails()
      .filter(
        (e) => e.categoryId === 'orders' && e.orderMeta?.status === 'Delivered'
      )
      .map((e) => e.raw.id);
    if (deliveredIds.length === 0) {
      this.notify('No delivered orders to archive');
      return;
    }
    await this.gmailService.archiveBatch(deliveredIds);
    this.notify(`Archived ${deliveredIds.length} delivered order(s)`);
  }

  async archiveRepoGroup(group: NotificationRepoGroup, event?: Event): Promise<void> {
    event?.stopPropagation();
    const ids = group.items.map((i) => i.raw.id);
    await this.gmailService.archiveBatch(ids);
    this.notify(
      `Archived ${ids.length} notification(s) from ${group.repoOrProject}`
    );
  }

  async archiveAllInCurrentCategory(): Promise<void> {
    const ids = this.activeEmails().map((e) => e.raw.id);
    if (ids.length === 0) return;
    await this.gmailService.archiveBatch(ids);
    this.notify(`Archived ${ids.length} message(s)`);
  }

  openForwardModal(email: CategorizedEmail, event?: Event): void {
    event?.stopPropagation();
    this.forwardingEmail.set(email);
    this.forwardTo.set('');
    this.forwardNote.set('Thought you might find this interesting:');
    this.forwardArchiveAfter.set(true);
  }

  closeForwardModal(): void {
    this.forwardingEmail.set(null);
  }

  async submitForward(): Promise<void> {
    const email = this.forwardingEmail();
    const to = this.forwardTo().trim();
    if (!email || !to) return;

    try {
      await this.gmailService.forwardEmail(email, to, this.forwardNote());
      if (this.forwardArchiveAfter()) {
        await this.gmailService.archiveEmail(email.raw.id);
      }
      this.forwardingEmail.set(null);
      this.notify(
        `Forwarded "${email.raw.subject.slice(0, 36)}" to ${to}${
          this.forwardArchiveAfter() ? ' & archived' : ''
        }`
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.notify(`Forward failed: ${msg}`);
    }
  }

  async rsvpEvent(
    email: CategorizedEmail,
    status: EventRsvpStatus,
    archiveAfter = false
  ): Promise<void> {
    this.rsvpOverrides.update((prev) => ({
      ...prev,
      [email.raw.id]: status,
    }));
    await this.gmailService.markAsRead(email.raw.id);
    if (archiveAfter) {
      await this.gmailService.archiveEmail(email.raw.id);
    }
    this.notify(`RSVP "${status}" recorded for ${email.eventMeta?.eventTitle}`);
  }

  getEffectiveRsvp(email: CategorizedEmail): EventRsvpStatus {
    return (
      this.rsvpOverrides()[email.raw.id] ||
      email.eventMeta?.rsvpStatus ||
      'Needs Action'
    );
  }

  getOrderStepIndex(status?: OrderDeliveryStatus): number {
    switch (status) {
      case 'Ordered':
        return 1;
      case 'Shipped':
        return 2;
      case 'Out for Delivery':
        return 3;
      case 'Delivered':
        return 4;
      default:
        return 1;
    }
  }

  // OAuth Modal methods
  openOAuthModal(): void {
    const cfg = this.gmailService.oauthConfig();
    this.oauthClientId.set(cfg.clientId);
    this.oauthClientSecret.set(cfg.clientSecret);
    this.oauthRedirectUri.set(cfg.redirectUri);
    this.showOAuthModal.set(true);
  }

  closeOAuthModal(): void {
    this.showOAuthModal.set(false);
  }

  saveOAuthSettings(): void {
    this.gmailService.saveOAuthConfig({
      clientId: this.oauthClientId(),
      clientSecret: this.oauthClientSecret(),
      redirectUri: this.oauthRedirectUri(),
    });
    this.notify('Saved Gmail OAuth configuration');
  }

  startAddGmailAccount(): void {
    this.saveOAuthSettings();
    if (!this.oauthClientId().trim()) {
      this.notify('Enter your GCP OAuth Client ID first');
      return;
    }
    const url = this.gmailService.buildGoogleOAuthUrl(
      this.oauthLoginHint().trim() || undefined
    );
    window.location.href = url;
  }

  // Custom Category Modal methods
  openAddCategoryModal(): void {
    this.newCatLabel.set('');
    this.newCatIcon.set('bookmark');
    this.newCatColor.set('#6366f1');
    this.newCatDescription.set('');
    this.newCatSenders.set('');
    this.newCatSubjects.set('');
    this.newCatBodies.set('');
    this.newCatRegex.set('');
    this.newCatRegexLabel.set('Reference');
    this.showAddCategoryModal.set(true);
  }

  closeAddCategoryModal(): void {
    this.showAddCategoryModal.set(false);
  }

  saveCustomCategory(): void {
    const label = this.newCatLabel().trim();
    if (!label) return;

    const splitCsv = (val: string) =>
      val
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

    const rule: CustomCategoryRule = {
      id: label.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
      label,
      icon: this.newCatIcon().trim() || 'bookmark',
      badgeColor: this.newCatColor() || '#6366f1',
      description:
        this.newCatDescription().trim() || `Custom category for ${label}`,
      senderKeywords: splitCsv(this.newCatSenders()),
      subjectKeywords: splitCsv(this.newCatSubjects()),
      bodyKeywords: splitCsv(this.newCatBodies()),
      extractRegex: this.newCatRegex().trim() || undefined,
      extractLabel: this.newCatRegexLabel().trim() || 'Extracted',
    };

    this.categoryRegistry.registerCustomCategory(rule);
    this.showAddCategoryModal.set(false);
    this.selectedCategoryId.set(rule.id);
    this.notify(`Added custom category "${rule.label}"`);
  }

  deleteCustomCategory(id: CategoryId, event?: Event): void {
    event?.stopPropagation();
    this.categoryRegistry.removeCustomCategory(id);
    if (this.selectedCategoryId() === id) {
      this.selectedCategoryId.set('all');
    }
    this.notify('Removed custom category');
  }

  private notify(message: string): void {
    this.snackBar.open(message, 'Dismiss', {
      duration: 3200,
      horizontalPosition: 'end',
      verticalPosition: 'bottom',
    });
  }
}
