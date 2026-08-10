import InfoPage, { Section } from "@/components/InfoPage";

export const metadata = { title: "How it works · Nostavel" };

export default function HowItWorksPage() {
  return (
    <InfoPage
      title="How Nostavel works"
      intro="Three steps from a rough idea to a booked room, without the tab-hopping."
    >
      <Section heading="1 · Tell us the shape of the trip">
        Where, when, how many of you. That is enough to start. You do not need to have decided on a
        neighborhood or a budget down to the dollar.
      </Section>
      <Section heading="2 · We hand back a short list">
        Instead of an endless grid, you get a curated set of stays worth your time, each with a
        live, fees-included price and a plain-language read on why it made the cut.
      </Section>
      <Section heading="3 · Book in one page">
        Enter your details once, pay securely, and you are done. Your confirmation and reference
        number arrive immediately and live under My Trips.
      </Section>
    </InfoPage>
  );
}
