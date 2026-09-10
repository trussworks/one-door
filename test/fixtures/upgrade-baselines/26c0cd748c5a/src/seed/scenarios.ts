import type { RequestScenario } from "./types.ts";

/**
 * Twelve golden scenarios. Each one states a need in program-office language
 * while the catalog describes the same capability in supplier language, so a
 * retrieval test that passes here has bridged meaning rather than matched
 * shared strings.
 *
 * Three scenarios carry expectedNoMatch. Each of the three sits next to a
 * catalog entry that looks close by category and is genuinely wrong, so the
 * matcher has to decline instead of reaching for the nearest neighbour.
 *
 * Every value in expectedCatalogMatches is a key in catalog.ts, and every
 * value in expectedPolicyRules is a code in policies.ts.
 */
export const requestScenarios = [
  {
    key: "disclosure-backlog",
    seedOrdinal: 0,
    title: "Copies asked for by the press arrive faster than we answer them",
    problem:
      "Reporters and residents ask us for copies of internal correspondence. Every ask is written into a shared spreadsheet by whoever opened the mail, and the countdown the law sets starts on the day the ask arrives. We miss that date about one time in five, and we have no way to see which asks are close to it.",
    affectedUsers:
      "Nine staff across three program offices who handle incoming asks, plus the counsel who checks what may be released",
    successMetrics: [
      "Share of asks answered before the date the law sets rises above 95 percent",
      "Median days from arrival to first response falls below 5",
      "Every ask has a named owner within one working day",
    ],
    requirements: [
      "One list of every incoming ask with the date it arrived and the date it is due",
      "A warning to the named owner before the date passes",
      "A way to black out the parts we are not allowed to share, keeping the original intact",
      "A freeze that stops the normal disposal cycle while a matter is contested",
      "A record of what was sent, to whom, and on which day",
    ],
    constraints: [
      "Counsel must approve any release before it leaves the building",
      "Originals must stay untouched for the required period",
      "Some material carries names and home addresses",
    ],
    conversation: [
      {
        actor: "submitter",
        content:
          "We are drowning in asks for copies of our correspondence and the spreadsheet is not holding up.",
      },
      {
        actor: "assistant",
        content:
          "Tell me what happens between an ask arriving and someone answering it. Who touches it, and where does the delay build up?",
      },
      {
        actor: "submitter",
        content:
          "Mail comes to a shared inbox. Whoever opens it types a row into the spreadsheet, then emails the program office that holds the material. The program office sends files back, counsel reads them, and someone posts the answer. The delay is almost always between the program office and counsel, because nobody knows the date is close until it has passed.",
      },
      {
        actor: "assistant",
        content:
          "So the missing piece is visibility of the deadline, not the search itself. How often do you miss it now, and what would good look like?",
      },
      {
        actor: "submitter",
        content:
          "About one in five. Good would be under one in twenty, and I would want to see at a glance which ones are within three days of the date.",
      },
      {
        actor: "assistant",
        content:
          "You mentioned counsel removing material. Is that happening inside a document today?",
      },
      {
        actor: "submitter",
        content:
          "Counsel prints it, marks it with a pen, and scans it back. We keep the marked copy and the clean copy in different folders, and twice we have sent the wrong one.",
      },
      {
        actor: "assistant",
        content:
          "That is the risk worth naming. Here is what I have: one list of asks with arrival and due dates, warnings before the due date, marking material without destroying the original, holds during contested matters, and a record of what was sent. Success is 95 percent on time, median first response under five days, and an owner within a day. Does that match?",
      },
      {
        actor: "submitter",
        content: "Yes. The wrong-copy problem is the one that keeps me up.",
      },
    ],
    expectedCatalogMatches: ["records-vault"],
    expectedPolicyRules: ["ACC-03", "PRV-01", "SEC-04"],
    riceDraft: { reach: 320, impact: 2, confidence: 0.8, effort: 4 },
  },
  {
    key: "inspector-paper-checklists",
    seedOrdinal: 1,
    title: "Inspectors write on paper and type it twice",
    problem:
      "Inspectors drive to sites with a printed checklist, write findings by hand, take pictures on a phone, and type all of it into the permitting system when they get back to the office. Half our territory has no usable signal, so working straight into the system on site is not possible today.",
    affectedUsers:
      "Forty-two inspectors across six districts, plus four office staff who chase missing paperwork",
    successMetrics: [
      "Time between a site call and a recorded result falls from four days to one",
      "Findings typed a second time drop to zero",
      "Every site call carries the pictures taken there",
    ],
    requirements: [
      "A portable device usable where there is no signal",
      "Checklists and what happened last time carried out of the office",
      "Pictures attached to the specific finding rather than to the whole trip",
      "Where the crew stood, recorded without typing an address",
      "Anything entered at the roadside lands in the permitting system without being typed again",
    ],
    constraints: [
      "Devices leave the building and are sometimes lost",
      "Some sites involve enforcement matters that are not public",
      "Inspectors make between three and eleven site calls in a day",
    ],
    conversation: [
      {
        actor: "submitter",
        content:
          "Our inspectors are typing the same findings twice and it is costing us days.",
      },
      {
        actor: "assistant",
        content:
          "Where does the second typing happen, and what stops them entering it once at the site?",
      },
      {
        actor: "submitter",
        content:
          "They enter it at the office in the evening or the next morning. They cannot enter it at the site because there is no signal across most of the rural districts, and the permitting system needs a live connection.",
      },
      {
        actor: "assistant",
        content:
          "Understood. What do they need to have with them when they arrive, and what do they produce while they are there?",
      },
      {
        actor: "submitter",
        content:
          "They need the checklist for that permit type and whatever happened last time. They produce findings, pictures, and sometimes a sketch. The pictures are the awkward part because right now they sit in a phone gallery and get matched up later, badly.",
      },
      {
        actor: "assistant",
        content:
          "Devices leaving the building with enforcement material on them raises a handling question. Are any of those visits non-public?",
      },
      {
        actor: "submitter",
        content:
          "Yes, anything under active enforcement. And we have lost four phones in two years.",
      },
      {
        actor: "assistant",
        content:
          "Then protection of the device contents belongs in the requirements. Summary: a portable device that works with no signal, checklists and past notes carried in, pictures tied to findings, location captured without typing, and one path back into the permitting system. Target is one day to a recorded result and no second typing. Right?",
      },
      {
        actor: "submitter",
        content:
          "That is it. The lost devices need an answer or our security office will stop this.",
      },
    ],
    expectedCatalogMatches: ["fieldmark-mobile", "permit-flow"],
    expectedPolicyRules: ["SEC-01", "SEC-03"],
    riceDraft: { reach: 140, impact: 2.5, confidence: 0.7, effort: 5 },
  },
  {
    key: "funding-panel-scoring-drift",
    seedOrdinal: 2,
    title: "Panel members mark the same application differently",
    problem:
      "Every spring about six hundred community organizations apply for funding. A panel of twelve reads them and marks each one out of a hundred on a paper sheet. Two panel members regularly differ by thirty points on the same application, and we cannot explain the gap to anyone who asks. The whole cycle takes seven weeks.",
    affectedUsers:
      "Twelve panel members, four program staff who compile the marks, and roughly six hundred applying organizations per cycle",
    successMetrics: [
      "Gap between the highest and lowest mark on the same application falls below ten points",
      "Cycle time from close of applications to published results drops from seven weeks to three",
      "Every funded and unfunded decision carries a written reason",
    ],
    requirements: [
      "Applications assigned to panel members without revealing who else is marking",
      "A shared marking sheet where each factor carries a stated weight",
      "A step where panel members compare marks on a small common set before the real marking begins",
      "A way to see which factor is causing two marks to differ",
      "Published reasons an applying organization can read",
    ],
    constraints: [
      "Panel members are volunteers who each give about eight hours",
      "Applicants may contest a result, and we have to show our working",
      "We are being asked whether a model could pre-mark applications",
    ],
    conversation: [
      {
        actor: "submitter",
        content:
          "Our funding panel gives wildly different marks to the same application and we cannot defend the results.",
      },
      {
        actor: "assistant",
        content:
          "How are the marks produced today, and what does a panel member actually see when marking?",
      },
      {
        actor: "submitter",
        content:
          "They see the full application as a printed pack and a one-page sheet with five headings. Each heading is out of twenty. There is no guidance on what a fifteen means as opposed to a ten, so people invent their own scale.",
      },
      {
        actor: "assistant",
        content:
          "That would explain a thirty point gap. Do panel members see each other marks while marking?",
      },
      {
        actor: "submitter",
        content:
          "Not deliberately, but they sit in the same room and talk, so yes, in practice.",
      },
      {
        actor: "assistant",
        content:
          "Someone mentioned pre-marking by a model. If that happened, would a panel member still make the decision?",
      },
      {
        actor: "submitter",
        content:
          "I would want them to, but honestly I do not know how we would prove it. And an applicant who is turned down will ask.",
      },
      {
        actor: "assistant",
        content:
          "That uncertainty is worth recording rather than smoothing over. Summary: assignment without visibility of other markers, a weighted sheet with stated meanings, a warm-up round on a common set, a view of which factor drives a gap, and published reasons. Target is a ten point spread and three weeks. Anything missing?",
      },
      {
        actor: "submitter",
        content:
          "No, but I want to be clear that we have never documented the current process, so any estimate is a guess.",
      },
    ],
    expectedCatalogMatches: ["grants-conductor"],
    expectedPolicyRules: ["AI-01", "AI-03", "PRC-01"],
    riceDraft: { reach: 260, impact: 2, confidence: 0.5, effort: 6 },
  },
  {
    key: "no-idea-which-form-applies",
    seedOrdinal: 3,
    title: "Residents cannot tell which of our forms applies to them",
    problem:
      "We publish about sixty separate online forms. A resident has to already know the name of the service before they can find the right one. Most people phone instead, and the first ten minutes of every call is a member of staff working out what the person actually needs before any work starts.",
    affectedUsers:
      "Around forty-eight hundred residents contacting us each quarter, and twenty-six staff who answer the phone",
    successMetrics: [
      "Share of contacts that reach the right program on the first try rises above 90 percent",
      "Average time spent working out what a caller needs falls below three minutes",
      "Share of contacts that start online rather than by phone rises above 60 percent",
    ],
    requirements: [
      "A single starting point that does not require knowing a service name",
      "A guided exchange that helps a person describe the outcome they want",
      "The exchange draws out how the person would know the problem was solved",
      "A written summary the person confirms before anything is submitted",
      "Routing to the responsible program based on what the person described",
    ],
    constraints: [
      "Anyone on the public internet can reach it",
      "Callers include people using a screen reader and people whose first language is not English",
      "Staff must be able to correct anything the guided exchange got wrong",
    ],
    conversation: [
      {
        actor: "submitter",
        content:
          "People cannot work out which of our forms to use, so they phone us and we spend the first ten minutes translating what they want into our vocabulary.",
      },
      {
        actor: "assistant",
        content:
          "What does the caller usually say first, and what do you need to learn before you can route them?",
      },
      {
        actor: "submitter",
        content:
          "They describe a situation, not a service. Something like a fence dispute with a neighbour, or needing help after a job loss. We need to know which program owns that situation, whether they qualify, and what evidence they will need. Nothing on our website is organized that way.",
      },
      {
        actor: "assistant",
        content:
          "Would a better search over the existing forms solve it, or is the gap earlier than that?",
      },
      {
        actor: "submitter",
        content:
          "Earlier. Even with perfect search, they do not know what to search for. We have tried a form builder and a better search box already, and both failed for the same reason.",
      },
      {
        actor: "assistant",
        content:
          "That is useful, because it rules out a whole class of answer. What has to be true before you would call this working?",
      },
      {
        actor: "submitter",
        content:
          "Someone with no idea what we call anything describes their situation in their own words, and ends up in the right place with a summary they recognize as their problem.",
      },
      {
        actor: "assistant",
        content:
          "Summary: one starting point, a guided exchange in plain words, drawing out the outcome and how success would be recognized, a confirmed written summary, and routing from the description. Ninety percent first-try routing, under three minutes of triage, most contacts starting online. Correct?",
      },
      {
        actor: "submitter",
        content:
          "Correct. And it has to work for someone using a screen reader on a phone.",
      },
    ],
    expectedCatalogMatches: [],
    rejectedCatalogMatches: ["citizen-connect-crm"],
    expectedPolicyRules: ["ACC-01", "ACC-02", "SEC-02", "AI-01"],
    expectedNoMatch: true,
    riceDraft: { reach: 4800, impact: 3, confidence: 0.6, effort: 8 },
  },
  {
    key: "notices-only-in-english",
    seedOrdinal: 4,
    title: "Our mailed notices go out only in English",
    problem:
      "Every notice we post goes out in English only. In two of our districts a large share of households speak something else at home, and those households phone us to have the letter read out by whoever answers. The phone reading is done by whichever staff member happens to speak the language, with no record of what was said.",
    affectedUsers:
      "Roughly fifteen hundred households per quarter across two districts, and eleven staff who take reading-out calls",
    successMetrics: [
      "Share of notices a household can read unaided rises above 85 percent",
      "Reading-out calls fall by three quarters",
      "Every wording that goes out is signed off by someone competent in it before posting",
    ],
    requirements: [
      "Notices produced so each household can read them unaided",
      "Our standard wording carried across identically each time rather than differently per notice",
      "Someone competent in the tongue signs off before anything is posted",
      "Signed-off wording kept and reused rather than remade each time",
      "What each household reads, stored on the household record",
    ],
    constraints: [
      "Notices carry names, addresses, and case reference numbers",
      "Getting a legal term wrong creates real liability",
      "Two of the tongues we need are set down in the opposite direction",
    ],
    conversation: [
      {
        actor: "submitter",
        content:
          "All our notices go out in English and a lot of the households we serve cannot read them.",
      },
      {
        actor: "assistant",
        content: "What happens now when one of those notices lands?",
      },
      {
        actor: "submitter",
        content:
          "They phone us and ask someone to read it out. We put them through to whoever on the floor speaks the language. It is unrecorded, unreviewed, and it depends entirely on who is at their desk.",
      },
      {
        actor: "assistant",
        content:
          "Are these notices legally operative, meaning a misstatement would matter?",
      },
      {
        actor: "submitter",
        content:
          "Very much. Some of them start a period in which the household has to act. If we render that wrongly we are in trouble.",
      },
      {
        actor: "assistant",
        content:
          "Then automatic rendering without a human check is off the table, and consistent handling of legal terms matters more than speed. Do the notices contain personal detail?",
      },
      {
        actor: "submitter",
        content:
          "Name, address, case number, and sometimes the reason for the decision.",
      },
      {
        actor: "assistant",
        content:
          "Sending that to an outside service raises a separate question we should flag now. Summary: notices each household can read unaided, our standard wording held constant, a competent person signing off, signed-off wording reused, and what each household reads stored on the record. Target is 85 percent readable unaided and reading-out calls down three quarters.",
      },
      {
        actor: "submitter",
        content:
          "Agreed, and two of the tongues are set down in the opposite direction, which has broken our templates before.",
      },
    ],
    expectedCatalogMatches: ["translate-bridge"],
    expectedPolicyRules: ["ACC-02", "AI-02", "PRV-01"],
    riceDraft: { reach: 1500, impact: 3, confidence: 0.7, effort: 4 },
  },
  {
    key: "which-procedure-copy-is-real",
    seedOrdinal: 5,
    title: "Nobody can tell which procedure is the one in force",
    problem:
      "Program managers keep operating procedures on their own drives and email them around when someone asks. When a manager leaves we routinely find three files with different dates and no way to tell which one staff were following. Two audits in a row have raised it.",
    affectedUsers:
      "About nine hundred staff who follow written procedures, and roughly forty managers who write them",
    successMetrics: [
      "Every procedure has exactly one file marked as in force",
      "Time to find the standing text of a named procedure falls below one minute",
      "Procedures left without an owner after a departure drop to zero",
    ],
    requirements: [
      "One place holding the procedure staff are meant to follow",
      "Superseded files kept and readable, clearly marked as no longer in force",
      "Search that reaches inside the files rather than only their titles",
      "Who is answerable for a procedure passes on unprompted when a post changes hands",
      "A note of who altered a procedure and when",
    ],
    constraints: [
      "Some procedures describe enforcement methods and are not public",
      "Managers will not adopt anything that adds steps to writing a procedure",
      "We do not know how many procedures exist today",
    ],
    conversation: [
      {
        actor: "submitter",
        content:
          "We cannot tell which copy of a procedure is the one people are supposed to follow.",
      },
      {
        actor: "assistant",
        content:
          "Where do the copies live today, and how does a member of staff find one?",
      },
      {
        actor: "submitter",
        content:
          "On personal drives, in email attachments, and a few on a shared drive nobody maintains. Staff ask their supervisor, and the supervisor forwards whatever they have.",
      },
      {
        actor: "assistant",
        content: "What triggered raising it now?",
      },
      {
        actor: "submitter",
        content:
          "Two audits, and a manager who retired in March. We found three versions of the same inspection procedure with dates spread over four years and staff following at least two of them.",
      },
      {
        actor: "assistant",
        content: "Do you need old copies kept, or only the current one?",
      },
      {
        actor: "submitter",
        content:
          "Kept. If someone acted under an older procedure we need to show what it said at the time, word for word.",
      },
      {
        actor: "assistant",
        content:
          "One more thing that affects sizing. Do you know how many procedures there are?",
      },
      {
        actor: "submitter",
        content:
          "No. My guess is somewhere between four hundred and fifteen hundred, which I realize is not much of a guess.",
      },
      {
        actor: "assistant",
        content:
          "I will record that as unknown rather than pick a number. Summary: one standing text per procedure, superseded files kept and marked, search inside the files, answerability passing on departure, and a note of every alteration. Target is a single standing text and under a minute to find it.",
      },
    ],
    expectedCatalogMatches: ["docmesh-repository", "archive-keeper"],
    expectedPolicyRules: ["SEC-01", "SEC-04"],
    riceDraft: { reach: 900, impact: 1, confidence: 0.9, effort: 3 },
    riceReviewed: { reach: 900, impact: 1, confidence: 0.4, effort: 3 },
  },
  {
    key: "permissions-outlive-the-job",
    seedOrdinal: 6,
    title: "People keep access to systems they left behind",
    problem:
      "When a member of staff moves between teams, the access they had before stays with them. We have no reliable way to answer who can reach a given system, and our auditor asked for proof covering the last twelve months. We produced a spreadsheet assembled by hand over three weeks and the auditor rejected it.",
    affectedUsers:
      "About thirty-two hundred staff accounts, roughly two hundred managers who would confirm access, and two people in the security office",
    successMetrics: [
      "Time to answer who can reach a named system falls from three weeks to one hour",
      "Permissions left behind after a team move drop below 2 percent of accounts",
      "Supervisor sign-off on who can reach what completes for every system twice a year",
    ],
    requirements: [
      "A single answer to who can reach which system, produced without anyone assembling it by hand",
      "Permissions withdrawn unprompted when a person changes post or leaves",
      "A regular round where supervisors keep or strike each person reach",
      "Proof an auditor will take without us building a spreadsheet",
      "One sign-in path for staff rather than a separate account per system",
    ],
    constraints: [
      "Supervisors will not finish a round that takes more than thirty minutes",
      "Some systems are operated by other agencies and we cannot change them",
      "The auditor returns in nine months",
    ],
    conversation: [
      {
        actor: "submitter",
        content:
          "Our auditor rejected the evidence we gave for who can reach which system, and rebuilding it took three weeks by hand.",
      },
      {
        actor: "assistant",
        content:
          "What did the auditor actually ask for, and what could you not produce?",
      },
      {
        actor: "submitter",
        content:
          "A list, per system, of every account with access, when it was granted, and who approved it. We could produce the accounts. We could not produce when or who approved, because most of it was granted by email years ago.",
      },
      {
        actor: "assistant",
        content:
          "So the gap is the provenance of a grant, not the grant itself. What happens today when someone changes team?",
      },
      {
        actor: "submitter",
        content:
          "Their new manager asks for what they need. Nobody asks the old manager to take anything away. So it accumulates, and after fifteen years some people can reach almost everything.",
      },
      {
        actor: "assistant",
        content:
          "Would supervisors sit down and go through it regularly if asked?",
      },
      {
        actor: "submitter",
        content:
          "They would do it once. If it takes an afternoon they will click approve on everything, which is worse than not asking.",
      },
      {
        actor: "assistant",
        content:
          "Worth recording, because it puts a hard limit on how much you can ask of a reviewer. Summary: one settled answer per system, unprompted withdrawal on post change, a short regular sign-off round, proof an auditor will take, and a single sign-in path. Target is one hour to answer, under 2 percent left behind, and two rounds a year.",
      },
      {
        actor: "submitter",
        content:
          "Yes. And some of these systems belong to other agencies, so we cannot change how they work.",
      },
    ],
    expectedCatalogMatches: ["access-steward", "identity-gateway"],
    expectedPolicyRules: ["SEC-01", "SEC-04"],
    riceDraft: { reach: 3200, impact: 1.5, confidence: 0.8, effort: 4 },
  },
  {
    key: "no-number-for-how-it-went",
    seedOrdinal: 7,
    title: "We have stories about how people found the service, not a number",
    problem:
      "Leadership asks every quarter whether the people we serve found the experience acceptable, and we answer with anecdotes from the phone lines. We have never asked anyone in an organized way. When a program improves something, we cannot show that it made any difference.",
    affectedUsers:
      "Roughly forty-eight hundred people served each quarter, plus the six program managers who report upward",
    successMetrics: [
      "A published figure for how people rated the experience, refreshed every quarter",
      "Reply rate above 20 percent of finished dealings",
      "Every program can compare its figure before and after a change",
    ],
    requirements: [
      "A short set of questions put to someone just after they finish what they came to do",
      "The same questions reaching people who gave up partway, through whatever way we already contact them",
      "Results split by program and by how the person reached us",
      "What people wrote in their own words, gathered so a manager reads the pattern rather than every line",
      "A figure comparable across quarters without being rebuilt each time",
    ],
    constraints: [
      "We must not ask anything we cannot justify keeping",
      "People who did not complete a transaction matter as much as those who did",
      "Some respondents will answer in a language other than English",
    ],
    conversation: [
      {
        actor: "submitter",
        content:
          "Leadership wants a number for how people found dealing with us, and all we have is what the phone staff remember.",
      },
      {
        actor: "assistant",
        content: "Has anything been asked before, even informally?",
      },
      {
        actor: "submitter",
        content:
          "One program put a paper card in the lobby about four years ago. We got sixty responses, all from people who were angry enough to write, and it went nowhere.",
      },
      {
        actor: "assistant",
        content:
          "That is the sampling trap. Who do you need to hear from that a lobby card would miss?",
      },
      {
        actor: "submitter",
        content:
          "People who gave up partway through. They are the ones we most need to hear from and they are exactly the ones who leave without saying anything.",
      },
      {
        actor: "assistant",
        content:
          "Understood. How many questions would someone actually answer?",
      },
      {
        actor: "submitter",
        content: "Two. Maybe three. Anything longer and we will get nothing.",
      },
      {
        actor: "assistant",
        content:
          "Summary: a short set of questions just after someone finishes, the same questions reaching people who gave up, results split by program and route in, what people wrote gathered by pattern, and a figure comparable across quarters. Target is a published quarterly figure and a reply rate above 20 percent.",
      },
      {
        actor: "submitter",
        content:
          "Yes. And whatever we ask has to be defensible, because our privacy officer will ask why we want each field.",
      },
    ],
    expectedCatalogMatches: ["survey-signal"],
    expectedPolicyRules: ["PRV-02", "ACC-02"],
    riceDraft: { reach: 4800, impact: 1, confidence: 0.9, effort: 2 },
  },
  {
    key: "callers-asking-where-it-stands",
    seedOrdinal: 8,
    title: "People phone because we never tell them anything",
    problem:
      "After someone applies, we say nothing until a decision is made, which can take eleven weeks. They phone to ask where it stands. Each of those calls takes about eight minutes and produces no new information for anyone, because the answer is almost always that it is still waiting.",
    affectedUsers:
      "Around twenty-six hundred applicants per quarter, and eighteen staff who answer status calls",
    successMetrics: [
      "Status calls fall by 60 percent",
      "Share of applicants who can state their current stage without phoning rises above 75 percent",
      "A note goes out within one hour of every stage change",
    ],
    requirements: [
      "A note when the application moves from one stage to the next",
      "The applicant chooses whether that note arrives by mail, by phone, or not at all",
      "Notes raised by the case system rather than typed by a member of staff",
      "Proof of what went out and whether it landed, visible to whoever takes the call",
      "Stages named in words an applicant understands rather than internal codes",
    ],
    constraints: [
      "Notes carry a case reference and sometimes the reason for a delay",
      "We do not know how many people would opt in",
      "Some applicants have no email address",
    ],
    conversation: [
      {
        actor: "submitter",
        content:
          "People phone constantly to ask where their application stands and we have nothing to tell them except that it is waiting.",
      },
      {
        actor: "assistant",
        content:
          "What does the applicant know today between applying and a decision?",
      },
      {
        actor: "submitter",
        content:
          "That we received it, because we send one acknowledgement. After that, nothing for up to eleven weeks.",
      },
      {
        actor: "assistant",
        content:
          "Are there stages inside those eleven weeks that would mean something to the applicant?",
      },
      {
        actor: "submitter",
        content:
          "Yes, four or five. But they are named things like pending secondary adjudication, which means nothing to a member of the public.",
      },
      {
        actor: "assistant",
        content:
          "So part of the work is naming the stages, not only sending the message. How would people want to hear?",
      },
      {
        actor: "submitter",
        content:
          "Text, I would guess, but that is a guess. A lot of our applicants do not have a working email address. We have never asked, so I genuinely do not know what the take-up would be.",
      },
      {
        actor: "assistant",
        content:
          "I will carry that through as an unknown. Summary: a note on each stage change, chosen route or none, raised by the case system, arrival visible to whoever takes the call, and stages named in plain words. Target is 60 percent fewer status calls and a message within an hour of a change.",
      },
      {
        actor: "submitter",
        content:
          "That is right. The staff on the phones need to see whether the note actually landed.",
      },
    ],
    expectedCatalogMatches: ["notify-stream", "case-atlas"],
    expectedPolicyRules: ["PRV-01", "ACC-02", "SEC-03"],
    riceDraft: { reach: 2600, impact: 2, confidence: 0.8, effort: 3 },
    riceReviewed: { reach: 2600, impact: 2, confidence: 0.45, effort: 3 },
  },
  {
    key: "levee-settlement-imagery",
    seedOrdinal: 9,
    title: "We need to measure how much the levees sank this year",
    problem:
      "Our survey crews fly small aircraft along four hundred miles of levee twice a year and bring back dense point measurements of the surface. We need to compare one flight against the previous one to find where the ground has settled by more than a few centimetres. Today two engineers do the comparison by eye in a desktop tool over about six weeks.",
    affectedUsers:
      "Two survey engineers, nine district flood staff who act on the findings, and the levee safety board that receives the report",
    successMetrics: [
      "Comparison of two flights completes in under a week",
      "Settlement beyond the threshold is found in every mile rather than the sampled sections",
      "The board report is produced from the comparison rather than rebuilt by hand",
    ],
    requirements: [
      "Ingest dense surface measurements from a flight",
      "Align one flight against an earlier flight so the same ground is compared",
      "Compute the vertical difference across the whole run and flag movement beyond a threshold",
      "Show the flagged locations against the levee segments the district staff work in",
      "Keep every processed flight so a later comparison can reach back years",
    ],
    constraints: [
      "A single flight produces several hundred gigabytes",
      "Levee weak points are treated as protected infrastructure detail",
      "The two engineers who do this today both retire within four years",
    ],
    conversation: [
      {
        actor: "submitter",
        content:
          "We fly the levees twice a year and we need to know where the ground sank between flights. Right now two engineers eyeball it for six weeks.",
      },
      {
        actor: "assistant",
        content:
          "What exactly comes back from a flight, and what do the engineers do with it?",
      },
      {
        actor: "submitter",
        content:
          "Dense point measurements of the surface, hundreds of gigabytes per flight. They load two flights into a desktop tool, align them by hand against fixed reference points, and look for differences. They only get through about a fifth of the length.",
      },
      {
        actor: "assistant",
        content:
          "We hold a mapping service that publishes layers and answers spatial questions. Would that cover this?",
      },
      {
        actor: "submitter",
        content:
          "No. It can draw the answer once we have it, but it cannot do the alignment or the vertical comparison. We have already tried. That is display, and this is measurement.",
      },
      {
        actor: "assistant",
        content:
          "Clear. Is there anything in-house that does the comparison itself?",
      },
      {
        actor: "submitter",
        content:
          "Nothing. The engineers use a desktop package they bought personally on an old licence, which is its own problem.",
      },
      {
        actor: "assistant",
        content:
          "Then this is likely a purchase or a build rather than a match, and the cost will need a competitive route. Summary: ingest dense surface measurements, align flights, compute vertical change across the full run, flag beyond a threshold, show against levee segments, and retain flights for later comparison. Target is under a week and full coverage.",
      },
      {
        actor: "submitter",
        content:
          "Yes. And the locations of weak points are not something we can publish.",
      },
    ],
    expectedCatalogMatches: [],
    rejectedCatalogMatches: ["forecast-bench"],
    expectedPolicyRules: ["PRC-01", "PRC-02", "SEC-03"],
    expectedNoMatch: true,
    riceDraft: { reach: 45, impact: 1.5, confidence: 0.3, effort: 12 },
  },
  {
    key: "retiring-benefit-calculation",
    seedOrdinal: 10,
    title:
      "The two people who understand our benefit calculation both retire next year",
    problem:
      "Our assistance payment amounts are worked out by a program written more than forty years ago that runs overnight on a machine nobody else supports. Two staff understand how it works. Both retire within fourteen months. The rules it encodes have never been written down anywhere else, and we cannot answer a challenge about how a specific amount was reached.",
    affectedUsers:
      "About twenty-one hundred households whose payment it calculates each month, eleven caseworkers who explain the amounts, and two staff who maintain the program",
    successMetrics: [
      "Every rule the program applies is written in a form a caseworker can read",
      "A specific payment amount can be explained back to the rules that produced it",
      "The calculation runs without either of the two retiring staff",
    ],
    requirements: [
      "Recover the decision rules out of the existing program and state them plainly",
      "Confirm each recovered rule against the amounts the current program produces",
      "Run the recovered rules against several years of past cases and account for every difference",
      "Let program staff change a rule afterwards without a specialist",
      "Show, for any payment, which rules applied and in which order",
    ],
    constraints: [
      "The amounts affect households directly and cannot change during the transfer",
      "The data includes program eligibility and health circumstances",
      "The two staff who understand it can give at most one day a week to this",
    ],
    conversation: [
      {
        actor: "submitter",
        content:
          "Our payment calculation runs on a forty-year-old program and the only two people who understand it retire next year.",
      },
      {
        actor: "assistant",
        content:
          "Is the problem replacing where it runs, or recovering what it does?",
      },
      {
        actor: "submitter",
        content:
          "Recovering what it does. Moving it somewhere else without understanding it would just move the problem. Nobody has ever written the rules down.",
      },
      {
        actor: "assistant",
        content:
          "We hold a system that determines program eligibility with a rules engine staff maintain. Would that take these rules once they were recovered?",
      },
      {
        actor: "submitter",
        content:
          "Possibly, eventually. But it will not read the old program and tell us what the rules are, and that is the entire job. Putting rules we do not yet know into a rules engine is not a plan.",
      },
      {
        actor: "assistant",
        content:
          "Agreed, and worth recording as a rejected option rather than leaving it to be suggested again. How would you know the recovery was correct?",
      },
      {
        actor: "submitter",
        content:
          "Run both against several years of real cases and account for every difference. Not most. Every one, because each difference is somebody payment.",
      },
      {
        actor: "assistant",
        content:
          "Summary: recover the rules and state them plainly, confirm each against current output, reconcile against years of past cases with every difference explained, let staff change rules afterwards, and show which rules produced any given amount. Target is written rules, an explainable amount, and no dependence on the two retiring staff.",
      },
      {
        actor: "submitter",
        content:
          "Correct. And the case data includes health circumstances, so handling is restricted.",
      },
    ],
    expectedCatalogMatches: [],
    rejectedCatalogMatches: ["benefits-navigator"],
    expectedPolicyRules: ["PRC-02", "AI-01", "SEC-04", "PRV-03"],
    expectedNoMatch: true,
    riceDraft: { reach: 210, impact: 3, confidence: 0.35, effort: 24 },
  },
  {
    key: "subscriptions-renewed-unnoticed",
    seedOrdinal: 11,
    title: "Two services rolled over on their own because nobody was watching",
    problem:
      "Last year two hosted services rolled over on their own because no one was counting back from the cut-off. We found out when the invoice arrived. Nobody keeps the diary of what ends when, deals sit in the drives of whoever signed them, and we cannot say how much of an approved ceiling is still unspent.",
    affectedUsers:
      "Six contract officers, about sixty budget holders who sponsor agreements, and the finance team that pays the invoices",
    successMetrics: [
      "Roll-overs that nobody chose fall to zero",
      "Every live deal has a named person accountable for it",
      "How much of any ceiling is left can be stated within five minutes",
    ],
    requirements: [
      "One list of everything we are still signed up to, showing when each one ends and how far ahead we must give word",
      "The named person told in good time before a deal rolls over on its own",
      "What we promised in each deal, followed through to done",
      "How much of an approved ceiling is still unspent, visible without opening the finance system",
      "Every bill checked against the deal that permitted it",
    ],
    constraints: [
      "Deals are held in several formats including scanned paper",
      "The word we must give ahead differs between thirty and one hundred and eighty days",
      "Finance and procurement use different reference numbers for the same deal",
    ],
    conversation: [
      {
        actor: "submitter",
        content:
          "Two subscriptions renewed on their own last year and we only found out when the bill arrived.",
      },
      {
        actor: "assistant",
        content:
          "Where do the agreements live today, and who is supposed to be watching the dates?",
      },
      {
        actor: "submitter",
        content:
          "On the drive of whoever signed them, and nobody. There is no register. When I ask which agreements expire this quarter, nobody can answer without opening files one by one.",
      },
      {
        actor: "assistant",
        content: "How much notice would you need to act on one?",
      },
      {
        actor: "submitter",
        content:
          "Depends on the agreement. Some need thirty days, one needs a hundred and eighty. Getting that wrong is exactly how we ended up paying for another year of something we had already replaced.",
      },
      {
        actor: "assistant",
        content:
          "You also mentioned unspent value. Is that a separate problem?",
      },
      {
        actor: "submitter",
        content:
          "Related. We approve a ceiling and then have no idea how much is left against it, so we occasionally approve a change order that puts us over.",
      },
      {
        actor: "assistant",
        content:
          "And the bill that arrived, was there anything checking it against the agreement?",
      },
      {
        actor: "submitter",
        content:
          "No. Finance pays what looks reasonable. They use a different reference number than we do, which is part of why nothing lines up.",
      },
      {
        actor: "assistant",
        content:
          "Summary: one list showing when each deal ends and how far ahead we must give word, the named person told early, promises followed through to done, unspent ceiling visible, and bills checked against the deal that permitted them. Target is no unchosen roll-overs, an owner on every deal, and unspent ceiling in five minutes.",
      },
    ],
    expectedCatalogMatches: ["contract-sentinel", "invoice-bridge"],
    expectedPolicyRules: ["PRC-01", "PRC-02", "PRC-03"],
    riceDraft: { reach: 60, impact: 2, confidence: 0.9, effort: 2 },
  },
  {
    key: "budget-office-azure-deployment",
    seedOrdinal: 12,
    title: "The Budget Office application has no approved production path",
    problem:
      "The Budget Office built a forecasting application that runs on developer laptops. The team needs the state cloud environment, identity, security review, delivery pipeline, logging, and operating ownership required to make it available to Budget Office staff.",
    affectedUsers:
      "Eight application team members and about eight hundred Budget Office staff who use forecasts during the annual budget cycle",
    successMetrics: [
      "The team can deploy an approved release without opening separate requests for each platform dependency",
      "Budget Office staff sign in through the state identity provider",
      "Application logs and service health are visible to the team that accepts production ownership",
    ],
    requirements: [
      "A Colorado Azure environment approved for the application data classification",
      "Application identity and secret storage that do not place credentials in source code",
      "A reviewed delivery pipeline that records each production release",
      "Central application logs, service metrics, and an incident-response handoff",
      "One coordinated service path with named owners for every dependency",
    ],
    constraints: [
      "The product owner has not yet confirmed the application data classification",
      "The application must be ready before the next annual budget cycle",
      "The Budget Office cannot operate the shared cloud foundation itself",
    ],
    conversation: [
      {
        actor: "submitter",
        content:
          "We built a budgeting application and need whatever lets us put it in Colorado Azure for our staff.",
      },
      {
        actor: "assistant",
        content:
          "What can the team do today, and what is missing between the current application and a production service?",
      },
      {
        actor: "submitter",
        content:
          "It runs on developer laptops. We do not have a cloud subscription, application identity, release pipeline, security approval, logging, or an operations team.",
      },
      {
        actor: "assistant",
        content:
          "What would tell you the application is ready for the Budget Office to use?",
      },
      {
        actor: "submitter",
        content:
          "Our team can deploy a reviewed release, staff sign in with their state account, and the production owner can see health and logs.",
      },
      {
        actor: "assistant",
        content:
          "What kind of information will the application store or process?",
      },
      {
        actor: "submitter",
        content:
          "The product owner still has to confirm the classification. It contains working budget forecasts but no payroll or health data.",
      },
      {
        actor: "assistant",
        content:
          "I will preserve the classification as missing information. The coordinated Azure deployment service appears to cover the environment, identity, delivery, review, logging, and operating handoff, with classification required before final approval.",
      },
    ],
    expectedCatalogMatches: [
      "colorado-azure-landing-zone",
      "azure-devops-delivery-platform",
      "credential-vault",
      "application-observability-service",
    ],
    expectedPolicyRules: ["POL-01", "SEC-01", "SEC-05", "SEC-06"],
    riceDraft: { reach: 800, impact: 2, confidence: 0.8, effort: 4 },
  },
] satisfies RequestScenario[];
