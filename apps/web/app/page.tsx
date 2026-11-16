import { BRAND, PRICING, formatInr } from '@assessiq/shared';

export default function HomePage() {
  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: '4rem 1rem' }}>
      <h1>{BRAND.PRODUCT}</h1>
      <p>Online assessments and verified certificates by {BRAND.COMPANY}.</p>
      <ul>
        <li>Trainers publish an exam for {formatInr(PRICING.EXAM_CREATION_PAISE)}.</li>
        <li>Students join with an exam code for {formatInr(PRICING.EXAM_JOIN_PAISE)}.</li>
      </ul>
      <p style={{ color: '#666' }}>Sprint 0 scaffold. Sign-in arrives in Sprint 1.</p>
    </main>
  );
}
