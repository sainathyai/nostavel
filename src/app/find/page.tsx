import InfoPage from "@/components/InfoPage";
import FindFlow from "./FindFlow";

export const metadata = { title: "Find your trip · Nostavel" };

export default function FindPage() {
  return (
    <InfoPage
      title="Find your trip"
      intro="Booked as a guest, no account? Enter the email on your booking and the lead guest's last name, and we'll email you a one-time code to pull it up."
    >
      <FindFlow />
      <p className="text-[13px] text-soft">
        Have an account instead?{" "}
        <a className="text-brass underline underline-offset-2 hover:text-brassglow" href="/trips">
          See all your trips
        </a>
        .
      </p>
    </InfoPage>
  );
}
