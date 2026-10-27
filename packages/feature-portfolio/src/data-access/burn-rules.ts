// Burning is reserved for dust and spam: anything worth real money must go
// through a send/swap instead. Unpriced tokens are treated as dust — if no
// price source knows the mint there is nothing measurable to lose.
export const BURN_MAX_VALUE_EUR = 10

export const burnValueAllowed = (valueEur: null | number): boolean => valueEur === null || valueEur < BURN_MAX_VALUE_EUR
