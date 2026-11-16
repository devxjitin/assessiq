import { z } from 'zod';

/** Request schemas shared by the API (validation) and the web app (forms). */

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Enter a valid email address')
  .max(254);

export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(128, 'Use at most 128 characters')
  .regex(/[A-Za-z]/, 'Include at least one letter')
  .regex(/[0-9]/, 'Include at least one number');

export const otpCodeSchema = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code');

const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9]{7,15}$/, 'Enter a valid phone number');

export const registerSchema = z.object({
  name: z.string().trim().min(2, 'Enter your name').max(100),
  email: emailSchema,
  password: passwordSchema,
  // Admins are created by NandiVex only; they can never self-register.
  role: z.enum(['STUDENT', 'EXAMINER']),
  phone: phoneSchema.optional(),
  orgName: z.string().trim().max(120).optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const verifyEmailSchema = z.object({ email: emailSchema, code: otpCodeSchema });
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;

export const resendOtpSchema = z.object({
  email: emailSchema,
  purpose: z.enum(['VERIFY_EMAIL', 'RESET_PASSWORD']).default('VERIFY_EMAIL'),
});
export type ResendOtpInput = z.infer<typeof resendOtpSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password').max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const forgotPasswordSchema = z.object({ email: emailSchema });
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({
  email: emailSchema,
  code: otpCodeSchema,
  newPassword: passwordSchema,
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const updateProfileSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    phone: phoneSchema.nullable(),
    orgName: z.string().trim().max(120).nullable(),
  })
  .partial();
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

/** What the API returns for a signed-in user. Never includes secrets. */
export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: 'STUDENT' | 'EXAMINER' | 'ADMIN';
  phone: string | null;
  orgName: string | null;
  emailVerifiedAt: string | null;
  createdAt: string;
}

export interface AuthResponse {
  accessToken: string;
  expiresInSeconds: number;
  user: PublicUser;
}
