import InfoPage, { Section } from "@/components/InfoPage";

export const metadata = { title: "Terms · Nostavel" };

export default function TermsPage() {
  return (
    <InfoPage
      title="Terms & privacy"
      intro="The short version. Nostavel is a demonstration travel-booking experience built on live supplier data."
    >
      <Section heading="Bookings">
        Rates, availability, and photos are supplied live by LiteAPI. Bookings are processed in a
        secure sandbox for demonstration purposes; no real payment is captured and no real stay is
        reserved.
      </Section>
      <Section heading="Your information">
        The details you enter at checkout are used only to complete the booking flow and show your
        reservation under My Trips. We do not sell your data.
      </Section>
      <Section heading="Payments">
        Card details are collected by Stripe directly and never touch Nostavel's servers. Test cards
        such as 4242 4242 4242 4242 are used in this environment.
      </Section>
    </InfoPage>
  );
}
