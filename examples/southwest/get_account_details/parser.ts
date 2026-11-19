type AccountResponse = {
  data?: {
    account?: {
      id?: string | null;
      type?: string | null;
      member_started_at?: string | null;
      redeemable_points?: number | null;
      current_cobrand_cardholder?: boolean | null;
      created_at?: string | null;
      tier?: {
        type?: string | null;
        status_pending?: boolean | null;
        status_ends_at?: string | null;
        qualifying_flights?: number | null;
        qualifying_points?: number | null;
        next_targeted?: string | null;
        next_qualifying_flights_required?: number | null;
        next_qualifying_points_required?: number | null;
        last_activity_earned_at?: string | null;
      } | null;
      companion_pass_qualifying_details?: {
        companion_declared?: boolean | null;
        companion_declaration_change_count?: number | null;
        expires_at?: string | null;
        pass_achieved?: boolean | null;
        qualifying_flights_required?: number | null;
        qualifying_flights?: number | null;
        qualifying_flights_remaining?: number | null;
        qualifying_points_required?: number | null;
        qualifying_points?: number | null;
        qualifying_points_remaining?: number | null;
      } | null;
    } | null;
  };
};

export function extract(rawResponse: unknown): unknown {
  const response = rawResponse as AccountResponse;
  if (
    !response ||
    typeof response !== 'object' ||
    !response.data ||
    typeof response.data !== 'object' ||
    !Object.prototype.hasOwnProperty.call(response.data, 'account')
  ) {
    throw new Error('SOUTHWEST_ACCOUNT_UNPARSED: expected data.account');
  }
  const account = response.data.account;
  if (!account || (!account.id && !account.type)) return { account: null };

  return {
    account: {
      id: account.id ?? null,
      type: account.type ?? null,
      member_started_at: account.member_started_at ?? null,
      created_at: account.created_at ?? null,
      redeemable_points: account.redeemable_points ?? null,
      current_cobrand_cardholder: account.current_cobrand_cardholder ?? null,
      tier: account.tier ? {
        type: account.tier.type ?? null,
        status_pending: account.tier.status_pending ?? null,
        status_ends_at: account.tier.status_ends_at ?? null,
        qualifying_flights: account.tier.qualifying_flights ?? null,
        qualifying_points: account.tier.qualifying_points ?? null,
        next_targeted: account.tier.next_targeted ?? null,
        next_qualifying_flights_required: account.tier.next_qualifying_flights_required ?? null,
        next_qualifying_points_required: account.tier.next_qualifying_points_required ?? null,
        last_activity_earned_at: account.tier.last_activity_earned_at ?? null,
      } : null,
      companion_pass: account.companion_pass_qualifying_details ? {
        companion_declared: account.companion_pass_qualifying_details.companion_declared ?? null,
        companion_declaration_change_count: account.companion_pass_qualifying_details.companion_declaration_change_count ?? null,
        expires_at: account.companion_pass_qualifying_details.expires_at ?? null,
        pass_achieved: account.companion_pass_qualifying_details.pass_achieved ?? null,
        qualifying_flights_required: account.companion_pass_qualifying_details.qualifying_flights_required ?? null,
        qualifying_flights: account.companion_pass_qualifying_details.qualifying_flights ?? null,
        qualifying_flights_remaining: account.companion_pass_qualifying_details.qualifying_flights_remaining ?? null,
        qualifying_points_required: account.companion_pass_qualifying_details.qualifying_points_required ?? null,
        qualifying_points: account.companion_pass_qualifying_details.qualifying_points ?? null,
        qualifying_points_remaining: account.companion_pass_qualifying_details.qualifying_points_remaining ?? null,
      } : null,
    },
  };
}
