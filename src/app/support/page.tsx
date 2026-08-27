import InfoPage, { Section } from "@/components/InfoPage";

export const metadata = { title: "Support · Nostavel" };

export default function SupportPage() {
  return (
    <InfoPage
      title="Support"
      intro="Something not right with a booking, or a question before you book? Here is how to reach us and what to have handy."
    >
      <Section heading="Find an existing booking">
        Every reservation has a reference like LNTRN-XXXX and shows up under My Trips. Have that
        reference and the email you booked with ready when you contact us.
      </Section>
      <Section heading="Changes and cancellations">
        Whether a stay can be changed or refunded depends on the rate you booked. The cancellation
        terms are shown before you pay and again on your confirmation.
      </Section>
      <Section heading="Contact">
        Email <a className="text-brass underline underline-offset-2 hover:text-brassglow" href="mailto:help@nostavel.com">help@nostavel.com</a>{" "}
        and we will get back to you. This is a demo environment, so bookings run in a secure sandbox
        and no real card is charged.
      </Section>
    </InfoPage>
  );
}
