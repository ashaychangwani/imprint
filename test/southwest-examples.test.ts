import { describe, expect, it } from 'bun:test';
import { extract as extractAccountDetails } from '../examples/southwest/get_account_details/parser.ts';

describe('Southwest example parsers', () => {
  it('extracts account details from the customer-details response slot', () => {
    const result = extractAccountDetails(
      { 'customers.UserInformation.accountNumber': 'RR-raw' },
      {
        params: {},
        responses: [
          { bootstrap: true },
          {
            'customers.userInformation.accountNumber': 'RR-login',
            'customers.userInformation.credential': 'login@example.com',
          },
          {
            data: {
              account: {
                id: 'RR-details',
                type: 'RAPID_REWARDS',
                redeemable_points: 12345,
                tier: { type: 'A_LIST', qualifying_flights: 12 },
              },
              personal_details: {
                first_name: 'Test',
                last_name: 'Traveler',
              },
            },
          },
          {
            'customers.UserInformation.primaryEmail': 'test@example.com',
          },
        ],
      },
    ) as {
      account: { account_number: string | undefined; redeemable_points: number | undefined };
      profile: { first_name: string | undefined; credential: string | undefined };
      contact: { primary_email: string | undefined };
      tier: { type: string | undefined; qualifying_flights: number | undefined };
    };

    expect(result.account.account_number).toBe('RR-details');
    expect(result.account.redeemable_points).toBe(12345);
    expect(result.profile.first_name).toBe('Test');
    expect(result.profile.credential).toBe('login@example.com');
    expect(result.contact.primary_email).toBe('test@example.com');
    expect(result.tier.type).toBe('A_LIST');
    expect(result.tier.qualifying_flights).toBe(12);
  });
});
