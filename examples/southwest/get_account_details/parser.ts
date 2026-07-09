type Dict = Record<string, unknown>;

type Context = {
  params: Record<string, string | number | boolean>;
  responses: unknown[];
};

function objectValue(value: unknown): Dict {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Dict) : {};
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0 && !value.startsWith('[REDACTED:')) return value;
  }
  return undefined;
}

function pickNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function pickBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

function fromFlat(data: Dict, prefix: string, key: string): unknown {
  return data[`${prefix}.${key}`];
}

export function extract(rawResponse: unknown, context?: Context): unknown {
  const responses = context?.responses ?? [];
  const login = objectValue(responses[0]);
  const details = objectValue(responses[1]);
  const userinfo = objectValue(rawResponse);
  const data = objectValue(details.data);
  const account = objectValue(data.account);
  const personal = objectValue(data.personal_details);
  const preferences = objectValue(data.preferences);
  const security = objectValue(data.traveler_security_details);
  const tier = objectValue(account.tier);
  const companion = objectValue(account.companion_pass_qualifying_details);

  const lowerPrefix = 'customers.userInformation';
  const upperPrefix = 'customers.UserInformation';

  const accountNumber = pickString(
    account.id,
    userinfo.sub,
    fromFlat(userinfo, upperPrefix, 'accountNumber'),
    fromFlat(login, lowerPrefix, 'accountNumber'),
  );

  if (!accountNumber && Object.keys(account).length === 0 && Object.keys(userinfo).length === 0) {
    return {
      account: null,
      profile: null,
      tier: null,
      companion_pass: null,
      contact: null,
      corporate: { active_company_id_associations: [] },
    };
  }

  return {
    account: {
      account_number: accountNumber,
      type: pickString(account.type, fromFlat(userinfo, upperPrefix, 'accountType'), fromFlat(login, lowerPrefix, 'accountType')),
      status: pickString(fromFlat(userinfo, upperPrefix, 'accountStatus'), fromFlat(login, lowerPrefix, 'accountStatus')),
      created_at: pickString(account.created_at, fromFlat(userinfo, upperPrefix, 'accountCreatedDate'), fromFlat(login, lowerPrefix, 'accountCreatedDate')),
      member_started_at: pickString(account.member_started_at, fromFlat(userinfo, upperPrefix, 'memberStartDate'), fromFlat(login, lowerPrefix, 'memberStartDate')),
      redeemable_points: pickNumber(account.redeemable_points, fromFlat(userinfo, upperPrefix, 'redeemablePoints'), fromFlat(login, lowerPrefix, 'redeemablePoints')),
      current_cobrand_cardholder: pickBoolean(account.current_cobrand_cardholder, fromFlat(userinfo, upperPrefix, 'chaseVisaRrEnrolled'), fromFlat(login, lowerPrefix, 'chaseVisaRrEnrolled')),
      chase_card: {
        display_name: pickString(fromFlat(userinfo, upperPrefix, 'chaseCardInfo.chaseCardDisplayName'), fromFlat(login, lowerPrefix, 'chaseCardInfo.chaseCardDisplayName')),
        value: pickString(fromFlat(userinfo, upperPrefix, 'chaseCardInfo.value'), fromFlat(login, lowerPrefix, 'chaseCardInfo.value')),
        southwest_multiplier: pickNumber(fromFlat(userinfo, upperPrefix, 'chaseCardInfo.southwestMultiplier'), fromFlat(login, lowerPrefix, 'chaseCardInfo.southwestMultiplier')),
      },
    },
    profile: {
      first_name: pickString(personal.first_name, fromFlat(userinfo, upperPrefix, 'firstName'), fromFlat(login, lowerPrefix, 'firstName')),
      last_name: pickString(personal.last_name, fromFlat(userinfo, upperPrefix, 'lastName'), fromFlat(login, lowerPrefix, 'lastName')),
      date_of_birth: pickString(personal.date_of_birth),
      gender: pickString(personal.gender),
      credential: pickString(fromFlat(login, lowerPrefix, 'credential')),
    },
    contact: {
      primary_email: pickString(fromFlat(userinfo, upperPrefix, 'primaryEmail'), fromFlat(login, lowerPrefix, 'primaryEmail')),
      primary_phone_number: pickString(fromFlat(userinfo, upperPrefix, 'primaryPhoneNumber'), fromFlat(login, lowerPrefix, 'primaryPhoneNumber')),
      us_address: pickBoolean(fromFlat(userinfo, upperPrefix, 'usAddress'), fromFlat(login, lowerPrefix, 'usAddress')),
    },
    tier: {
      type: pickString(tier.type, fromFlat(userinfo, upperPrefix, 'tier'), fromFlat(login, lowerPrefix, 'tier')),
      status_pending: pickBoolean(tier.status_pending, fromFlat(userinfo, upperPrefix, 'tierStatusPending'), fromFlat(login, lowerPrefix, 'tierStatusPending')),
      achieved_at: pickString(fromFlat(userinfo, upperPrefix, 'tierAchievedDate'), fromFlat(login, lowerPrefix, 'tierAchievedDate')),
      status_ends_at: pickString(tier.status_ends_at, fromFlat(userinfo, upperPrefix, 'tierEndDate'), fromFlat(login, lowerPrefix, 'tierEndDate')),
      qualifying_flights: pickNumber(tier.qualifying_flights, fromFlat(userinfo, upperPrefix, 'tierQualifyingFlights'), fromFlat(login, lowerPrefix, 'tierQualifyingFlights')),
      qualifying_points: pickNumber(tier.qualifying_points, fromFlat(userinfo, upperPrefix, 'tierQualifyingPoints'), fromFlat(login, lowerPrefix, 'tierQualifyingPoints')),
      next_targeted: pickString(tier.next_targeted, fromFlat(userinfo, upperPrefix, 'nextTierTargeted'), fromFlat(login, lowerPrefix, 'nextTierTargeted')),
      next_qualifying_flights_required: pickNumber(tier.next_qualifying_flights_required),
      next_qualifying_points_required: pickNumber(tier.next_qualifying_points_required, fromFlat(userinfo, upperPrefix, 'nextTierQualifyingPointsRequired'), fromFlat(login, lowerPrefix, 'nextTierQualifyingPointsRequired')),
      last_activity_earned_at: pickString(tier.last_activity_earned_at),
    },
    companion_pass: {
      declared: pickBoolean(companion.companion_declared, fromFlat(userinfo, upperPrefix, 'companionPassInfo.companionDeclared'), fromFlat(login, lowerPrefix, 'companionPassInfo.companionDeclared')),
      achieved: pickBoolean(companion.pass_achieved, fromFlat(userinfo, upperPrefix, 'companionPassInfo.companionPassAchieved'), fromFlat(login, lowerPrefix, 'companionPassInfo.companionPassAchieved')),
      expires_at: pickString(companion.expires_at, fromFlat(userinfo, upperPrefix, 'companionPassInfo.companionPassExpirationDate'), fromFlat(login, lowerPrefix, 'companionPassInfo.companionPassExpirationDate')),
      declaration_change_count: pickNumber(companion.companion_declaration_change_count),
      qualifying_flights_required: pickNumber(companion.qualifying_flights_required),
      qualifying_flights: pickNumber(companion.qualifying_flights),
      qualifying_flights_remaining: pickNumber(companion.qualifying_flights_remaining),
      qualifying_points_required: pickNumber(companion.qualifying_points_required, fromFlat(userinfo, upperPrefix, 'companionPassInfo.companionQualifyingPointsRequired'), fromFlat(login, lowerPrefix, 'companionPassInfo.companionQualifyingPointsRequired')),
      qualifying_points: pickNumber(companion.qualifying_points, fromFlat(userinfo, upperPrefix, 'companionPassInfo.companionQualifyingPoints'), fromFlat(login, lowerPrefix, 'companionPassInfo.companionQualifyingPoints')),
      qualifying_points_remaining: pickNumber(companion.qualifying_points_remaining, fromFlat(userinfo, upperPrefix, 'companionPassInfo.companionQualifyingPointsRemaining'), fromFlat(login, lowerPrefix, 'companionPassInfo.companionQualifyingPointsRemaining')),
    },
    preferences: {
      receive_drink_coupons: pickBoolean(preferences.receive_drink_coupons),
    },
    traveler_security: {
      known_traveler_number: pickString(security.known_traveler_number),
    },
    corporate: {
      active_company_id_associations: Array.isArray(userinfo['corporate.customerUserInformation.activeCompanyIdAssociations'])
        ? userinfo['corporate.customerUserInformation.activeCompanyIdAssociations']
        : Array.isArray(login['corporate.customerUserInformation.activeCompanyIdAssociations'])
          ? login['corporate.customerUserInformation.activeCompanyIdAssociations']
          : [],
    },
  };
}
