import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { AppComponent } from './app.component';
import { CategoryRegistryService } from './services/category-registry.service';
import { GmailApiService } from './services/gmail-api.service';
import { RawEmailMessage } from './models/mail.model';

describe('Mail Forge — AppComponent & CategoryRegistryService', () => {
  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [provideNoopAnimations()],
    }).compileComponents();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('should create the Mail Forge app and render multi-account pills', () => {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.brand-title')?.textContent).toContain('Mail Forge');
    expect(fixture.componentInstance.accounts().length).toBe(3);
  });

  it('should categorize all 6 built-in categories and extract structured metadata', () => {
    const registry = TestBed.inject(CategoryRegistryService);
    const gmail = TestBed.inject(GmailApiService);
    const categorized = gmail.categorizedEmails();

    const twoFactor = categorized.find((e) => e.raw.id === 'msg_2fa_1');
    expect(twoFactor?.categoryId).toBe('two_factor');
    expect(twoFactor?.twoFactorMeta?.code).toBe('849204');
    expect(twoFactor?.twoFactorMeta?.serviceName).toBe('GitHub');

    const orderJsonLd = categorized.find((e) => e.raw.id === 'msg_order_2');
    expect(orderJsonLd?.categoryId).toBe('orders');
    expect(orderJsonLd?.orderMeta?.merchant).toBe('B&H Photo Video');
    expect(orderJsonLd?.orderMeta?.carrier).toBe('UPS');
    expect(orderJsonLd?.orderMeta?.trackingNumber).toBe('1Z999AA10123456784');
    expect(orderJsonLd?.orderMeta?.status).toBe('Shipped');

    const bill = categorized.find((e) => e.raw.id === 'msg_bill_1');
    expect(bill?.categoryId).toBe('bills');
    expect(bill?.billMeta?.amountDue).toBe('$1,428.50');
    expect(bill?.billMeta?.accountLast4).toBe('4821');
    expect(bill?.billMeta?.status).toBe('Due Soon');

    const event = categorized.find((e) => e.raw.id === 'msg_event_1');
    expect(event?.categoryId).toBe('events');
    expect(event?.eventMeta?.isVirtual).toBeTrue();
    expect(event?.eventMeta?.meetingUrl).toContain('meet.google.com');

    const notif = categorized.find((e) => e.raw.id === 'msg_notif_1');
    expect(notif?.categoryId).toBe('notifications');
    expect(notif?.notificationMeta?.repoOrProject).toBe('fleker/feedly-for-obsidian');
    expect(notif?.notificationMeta?.referenceId).toBe('#42');

    const newsletter = categorized.find((e) => e.raw.id === 'msg_news_1');
    expect(newsletter?.categoryId).toBe('newsletters');
    expect(newsletter?.newsletterMeta?.publication).toContain('ByteByteGo');
    expect(newsletter?.newsletterMeta?.unsubscribeUrl).toContain('substack.com');

    const direct = categorized.find((e) => e.raw.id === 'msg_inbox_1');
    expect(direct?.categoryId).toBe('inbox');
    expect(registry.plugins().length).toBeGreaterThanOrEqual(6);
  });

  it('should filter emails by account and search query', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    fixture.detectChanges();

    const totalCount = app.activeEmails().length;
    app.selectAccount('acct_dev');
    expect(app.activeEmails().length).toBeLessThan(totalCount);
    expect(app.activeEmails().every((e) => e.raw.accountId === 'acct_dev')).toBeTrue();

    app.selectAccount('all');
    app.searchQuery.set('1Z999AA10123456784');
    expect(app.activeEmails().length).toBe(1);
    expect(app.activeEmails()[0].raw.id).toBe('msg_order_2');
  });

  it('should switch to specialized category view templates', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;

    app.selectCategory('orders');
    expect(app.activeViewTemplate()).toBe('orders_tracker');
    expect(app.ordersSummary().total).toBe(3);

    app.selectCategory('notifications');
    expect(app.activeViewTemplate()).toBe('notifications_rollup');
    expect(app.notificationGroups().length).toBe(2);

    app.selectCategory('newsletters');
    expect(app.activeViewTemplate()).toBe('newsletters_reader');
    expect(app.selectedNewsletter()).toBeTruthy();

    app.selectCategory('bills');
    expect(app.activeViewTemplate()).toBe('bills_ledger');
    expect(app.billsSummary().manualActionCount).toBe(2);

    app.selectCategory('events');
    expect(app.activeViewTemplate()).toBe('events_agenda');

    app.selectCategory('two_factor');
    expect(app.activeViewTemplate()).toBe('two_factor_vault');
  });

  it('should archive delivered orders and batch-archive notification repo groups', async () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;

    app.selectCategory('orders');
    expect(app.ordersSummary().delivered).toBe(1);
    await app.archiveDeliveredOrders();
    expect(app.ordersSummary().delivered).toBe(0);

    app.selectCategory('notifications');
    const feedlyGroup = app
      .notificationGroups()
      .find((g) => g.repoOrProject === 'fleker/feedly-for-obsidian')!;
    expect(feedlyGroup.items.length).toBe(2);
    await app.archiveRepoGroup(feedlyGroup);
    expect(
      app
        .notificationGroups()
        .find((g) => g.repoOrProject === 'fleker/feedly-for-obsidian')
    ).toBeUndefined();
  });

  it('should forward a newsletter and archive it when forwardArchiveAfter is enabled', async () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;

    app.selectCategory('newsletters');
    const nl = app.selectedNewsletter()!;
    app.openForwardModal(nl);
    app.forwardTo.set('teammate@example.com');
    app.forwardNote.set('Great read on IMAP vs JMAP!');
    app.forwardArchiveAfter.set(true);

    await app.submitForward();
    expect(app.forwardingEmail()).toBeNull();
    expect(app.activeEmails().some((e) => e.raw.id === nl.raw.id)).toBeFalse();
  });

  it('should register a custom category rule dynamically and extract regex metadata', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;

    app.openAddCategoryModal();
    app.newCatLabel.set('Tabletop & Lore');
    app.newCatIcon.set('map');
    app.newCatSubjects.set('Libertopolis, Map-Forge');
    app.newCatRegex.set('(Map-Forge)');
    app.newCatRegexLabel.set('Project');
    app.saveCustomCategory();

    expect(app.selectedCategoryId()).toBe('tabletop_lore');
    expect(app.activeEmails().length).toBe(1);
    expect(app.activeEmails()[0].customMeta?.['Project']).toBe('Map-Forge');
  });

  it('should parse raw Gmail API message payloads with base64url bodies', () => {
    const gmail = TestBed.inject(GmailApiService);
    const rawBody = btoa('Your verification code is 774123');
    const parsed: RawEmailMessage = gmail.parseGmailApiMessage(
      {
        id: 'gmail_101',
        threadId: 'th_101',
        internalDate: String(Date.now()),
        labelIds: ['INBOX', 'UNREAD'],
        snippet: 'Your verification code is 774123',
        payload: {
          headers: [
            { name: 'From', value: '"Stripe Security" <support@stripe.com>' },
            { name: 'To', value: 'nick.personal@gmail.com' },
            { name: 'Subject', value: 'Stripe verification code: 774123' },
          ],
          mimeType: 'text/plain',
          body: { data: rawBody },
        },
      },
      gmail.accounts()[0]
    );

    expect(parsed.fromName).toBe('Stripe Security');
    expect(parsed.fromEmail).toBe('support@stripe.com');
    expect(parsed.bodyText).toContain('774123');
  });
});
