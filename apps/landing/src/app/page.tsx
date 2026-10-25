import { Agents } from "@/sections/Agents";
import { Closing } from "@/sections/Closing";
import { Faq } from "@/sections/Faq";
import { Footer } from "@/sections/Footer";
import { Hero } from "@/sections/Hero";
import { HowItWorks } from "@/sections/HowItWorks";
import { Intro } from "@/sections/Intro";
import { Nav } from "@/sections/Nav";
import { Privacy } from "@/sections/Privacy";
import { Roadmap } from "@/sections/Roadmap";
import { Vocabulary } from "@/sections/Vocabulary";

export default function Home() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Intro />
        <hr className="sep" />
        <HowItWorks />
        <Vocabulary />
        <Agents />
        <hr className="sep" />
        <Privacy />
        <hr className="sep" />
        <Roadmap />
        <hr className="sep" />
        <Faq />
        <Closing />
      </main>
      <Footer />
    </>
  );
}
