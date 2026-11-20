import { z } from 'zod';

/** Closing your own account. The password is asked again so a stolen session cannot do it. */
export const deleteAccountSchema = z.object({
  password: z.string().min(1, 'Enter your password').max(128),
});
export type DeleteAccountInput = z.infer<typeof deleteAccountSchema>;
