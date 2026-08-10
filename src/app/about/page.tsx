import InfoPage, { Section } from "@/components/InfoPage";

export const metadata = { title: "About · Nostavel" };

export default function AboutPage() {
  return (
    <InfoPage
      title="A concierge, not a search engine."
      intro="Most travel sites hand you ten thousand results and call it choice. Nostavel does the opposite: you tell us where and when, and we hand back a short list actually worth booking, usually for less than the big sites charge."
    >
      <Section heading="Fewer, better">
        We would rather show you six great stays than six hundred mediocre ones. Every place on a
        Nostavel list is one we would be comfortable booking ourselves.
      </Section>
      <Section heading="Honest pricing">
        The price you see includes taxes and fees, locked at the moment you book. No drip-pricing,
        no surprise resort charge at the counter.
      </Section>
      <Section heading="Real inventory">
        Availability, photos, and rates are live. When you book, you get a genuine confirmation and
        reference number, and your reservation shows up under My Trips.
      </Section>
    </InfoPage>
  );
}
