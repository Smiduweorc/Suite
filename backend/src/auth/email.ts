import { normalizeEmail } from "phasmid";

/**
 * The mailbox an address reaches, which is what an account is keyed on.
 * `John.Doe+news@googlemail.com` and `johndoe@gmail.com` are one Gmail inbox, so
 * registering the second is a CONFLICT. phasmid knows each provider's rules.
 *
 * For an unknown domain phasmid leaves the local part alone (RFC 5321 allows it to be
 * case-sensitive). `defaultRule` opts back into case-insensitive local parts and nothing
 * more: `+tags` on an unknown domain might be a different mailbox.
 *
 * `users.email` still stores the typed address, lowercased, for display and mail.
 */
export function emailKey(email: string): string {
	return normalizeEmail(email, { defaultRule: { lowercaseLocal: true } });
}
