# How to create and publish a free course

You can use Sanity Studio to add your course videos, written lessons, and quizzes. Visitors sign up for Lash Her marketing emails to open the course. The signup form is already included on each course page.

This guide uses **Lash Care Essentials** as an example. Replace the example names and content with your own.

## Before you begin

Have these ready:

- Your Sanity Studio sign-in and the Studio link provided by your website team. The link usually ends in `/studio`.
- Your course title and a short introduction.
- A video, written lesson, and at least one quiz question for each part of the course.
- Any cover images, video preview images, captions, and written copies of the spoken lessons you want to include.
- An email address you can use to try the signup form.

If your team has given you a test website, use it first. Publishing there will not publish the course on the live website. Your website team can help you move the finished course when it is ready.

Only upload material you are comfortable sharing publicly. The signup form does not make the uploaded video files private.

## 1. Add your course details

1. Sign in to **Sanity Studio**.
2. Open **Content → Short Courses**.
3. Choose the option to create a **Short Course**.
4. Fill in the details below.

| Field in Studio  | What to enter                                                                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Title**        | Your course name, such as **Lash Care Essentials**. This appears at the top of the course page.                                                                                                                                |
| **Slug**         | The final part of the course's web address. Generate it from the title, or enter something like `lash-care-essentials`. Use lowercase letters, numbers, and hyphens, with no spaces. Do not include `/courses/` in this field. |
| **Introduction** | A short description of what the course covers and what someone will learn. Visitors can read this before signing up.                                                                                                           |
| **Cover image**  | An optional image shown beside the signup form. A wide image works well. In **Alternative text**, add a brief description of the image for people using a screen reader.                                                       |

For example, the slug `lash-care-essentials` gives you a course address ending in `/courses/lash-care-essentials`.

Keep the course as a **draft** while you add the lessons. A draft is your work in progress; visitors cannot see it until you publish it.

### Optional: how the course appears in search results

The **SEO** section lets you suggest a title and description for search engines. You can leave these fields empty to use your course title and introduction.

**Hide from search engines** asks search engines not to list the course. People with its link can still open it, so this setting does not make it private.

## 2. Add your first lesson and video

Studio calls each section of the course a **Module**. A module contains a video, written lesson, and quiz. You can add between 1 and 30 modules.

1. Find **Modules**, add a **Module**, and open it.
2. Enter a **Title**, such as **Welcome to the course**. Learners will see this in the course outline.
3. Fill in **Lesson text** with the written lesson or key points. This appears below the video and is required for every module. You can use bold and italic text to highlight useful details.
4. Find **Video (Mux)**, choose the upload option, and select the video file from your computer. You can also select an existing video from the plugin library. Keep playback set to **Public**.
5. Wait for both uploading and Mux processing to finish. Check the video preview before publishing. If Studio asks for Mux credentials, follow the [Mux setup guide](mux-course-videos.md#credentials-where-to-configure-them).
6. Add any of the optional items below, then continue to the quiz.

| Optional field                | What it does                                                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Video poster**              | A still image displayed before someone plays the video. This is separate from the course cover image. Leave it empty to use the Mux thumbnail. |
| **English captions (WebVTT)** | Words that appear on screen as the video plays. Upload an English captions file ending in `.vtt`. Your video editor can provide this.          |
| **Transcript**                | A written copy of what is said in the video. Paste the text here. Learners can open it by selecting **Read video transcript**.                 |

Include captions and a transcript for spoken lessons so people can follow the material without relying on sound. You still need to fill in **Lesson text** when you add a transcript.

### Choosing the video file

Upload your source video, such as an **MP4**. Mux prepares it for streaming automatically. The upload-by-URL option accepts a direct video file URL, including an existing Sanity file URL; use the original file instead of a YouTube or Vimeo page link.

If someone edits your videos for you, ask them for a high-quality MP4 and an English `.vtt` captions file. Changing a file's name to end in `.mp4` or `.vtt` does not change its format.

After publishing, play the video on both a computer and a phone. Check that the sound works, you can skip ahead, and the captions match the spoken words.

## 3. Add the quiz

Each module needs a short practice quiz with **1–10 questions**. Every question needs **2–6 answer choices**, with **exactly one correct answer**.

1. In the module, find **Quiz** and add a **Question**.
2. In **Prompt**, type the question you want to ask.
3. In **Options**, add an **Answer** and enter its wording in **Text**. Repeat for the other answer choices.
4. Turn on **Correct answer** for the right answer. Leave it off for the others.
5. Fill in **Explanation** with a short note explaining the right answer. Everyone sees this after submitting, including people who answered correctly.
6. Add more questions if needed.

Here is an example for a welcome lesson that explains how to use the course:

| Field                                    | Example                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| **Prompt**                               | Where can you read the words spoken in the video?                        |
| First answer                             | Select “Read video transcript” below the lesson.                         |
| **Correct answer** for the first answer  | On                                                                       |
| Second answer                            | Open the course signup form.                                             |
| **Correct answer** for the second answer | Off                                                                      |
| **Explanation**                          | Open “Read video transcript” to read the spoken lesson at your own pace. |

### How quiz completion works

Learners choose an answer for every question, then select **Check answers**. They see their score, the correct answers, and your explanations.

These are practice quizzes: a module is marked complete once all questions are answered and submitted, even if some or all answers are incorrect. There is no passing score to set. Watching the video alone does not mark a module complete.

Learners can select **Try quiz again** without losing their completed status. When all modules are complete, the page shows **Course complete**. A certificate is not issued automatically.

## 4. Add the rest of your lessons

Repeat steps 2 and 3 for each module. Drag the modules into the order you want them to appear.

The module titles also appear in the **What you'll learn** outline before signup, so use titles that clearly describe each lesson. After signing up, learners can open the modules in any order.

Before publishing, check that every module has:

- A clear title and written lesson.
- A Mux video that has finished processing and has Public playback enabled.
- At least one quiz question.
- Exactly one correct answer and an explanation for each question.

## 5. Review the signup experience

The course page includes a **Start your free course** form. Visitors enter their **Email address**, agree to receive marketing emails, and select **Sign up and access course**.

The agreement reads:

> I agree to receive lash care tips, service updates, and offers from Lash Her by Nataliea. I can unsubscribe at any time and keep access to this course.

Visitors must tick the checkbox themselves before signing up. This wording is shared across courses and cannot be edited in the course's Studio fields. Ask your website team if it needs changing.

After a successful signup:

- The lessons open without waiting for a confirmation email.
- The person is added to your marketing contacts. It may take a few minutes for your email service to update.
- Their access is remembered in that browser for up to one year. Their lesson progress is also remembered there.
- They can unsubscribe from marketing emails and keep their existing course access.

Someone who changes devices or browsers, or clears their browser's saved website data, may need to sign up again. Their progress does not automatically move to another device. A previous subscriber who signs up again and agrees to marketing emails can be subscribed again.

Publishing a course does **not** automatically send a welcome email or a marketing campaign. If you want either, arrange it separately with the person who manages your email marketing.

## 6. Publish and try the course yourself

Publishing makes the course available to visitors on the website you are editing. Finish the content checks first, then test the published page before sharing its link widely.

1. Review any missing-field messages in Studio and fill in the required details.
2. Select **Publish** on the course. This publishes all of its modules together.
3. Open the matching website and add your course address, such as `/courses/lash-care-essentials`, after the website name.
4. Use a **private or incognito browser window** to see what a new visitor sees. Check the cover image, introduction, and course outline.
5. Try the signup form with your own email address. Check that it requires the marketing agreement before opening the lessons.
6. Open each module. Play the video, check the sound and captions, read the lesson, and open the transcript if you added one.
7. Complete each quiz. Try an incorrect answer as well as a correct one, and check that the feedback makes sense. Try the **Try quiz again** button.
8. Complete every module and check that **Course complete** appears.

To check that access and progress are remembered, also try the course in a **normal browser window**. Sign up, make some progress, then close and reopen the course in that same browser. Private windows may forget your progress when you close them.

Draft changes will not appear on the course page until you select **Publish** again. If published changes still do not appear after refreshing the page, ask your website team to check.

## 7. Check that the signup appears in your marketing contacts

If you have access to the website's admin dashboard:

1. Open the dashboard at `/admin` on the same website you used for the course.
2. Choose **Marketing**, then **Contacts**. This area is separate from Sanity Studio.
3. Search for the email address you used to test the course.
4. Check the saved full name, email address, phone number, and optional Instagram handle. Confirm that the contact is marked **Opted in** and **Course sign-up** appears as a source. The **Source** filter can help you find course signups.
5. Check **Latest sync**, which shows whether the contact has been sent to your email service. Allow a few minutes for this to update to **Synced**.

If the contact does not appear, or the status continues to show **Waiting to sync**, **Retry scheduled**, or **Needs manual review**, ask your website team to investigate. Give them the course link and the message shown on screen.

If you do not have dashboard access, ask the person who manages marketing contacts to make this check. **Synced** means the contact was added to the email service; it does not mean a welcome email was sent.

## 8. Share the course link

Once you have checked the course and signup, copy the full course address from your browser to use in your website links or marketing material.

To add the course to the website menu:

1. In Studio, open **Pages → Navigation Menu**.
2. In **Menu Items**, add a **Menu Direct Link**.
3. Enter a **Title**, such as **Free lash care course**. This is the label visitors will see in the menu.
4. In **URL**, enter the course address beginning with `/courses/`, such as `/courses/lash-care-essentials`.
5. Publish the navigation menu, then open the website and try the link.

Publishing a course does not add it to the menu automatically. Link to the specific course address; `/courses` on its own is not a course listing page.

Avoid changing the **Slug** after sharing the course. Changing it changes the web address, and the old link will stop working.

## Updating or removing a course

To make a change, open the existing course in **Content → Short Courses**, edit it, and select **Publish** again.

Edit existing modules where possible instead of deleting and rebuilding them. This helps preserve learners' saved progress.

| What you change                                                               | What happens for returning learners                                                   |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Reorder modules, or edit a title, lesson text, image, captions, or transcript | Saved progress stays in place.                                                        |
| Edit a quiz, including an explanation or the order of answers                 | Saved answers and completion for that module reset when the updated course is opened. |
| Replace a video                                                               | The saved playback position resets. Quiz completion stays if the quiz is unchanged.   |
| Delete a module and create it again                                           | Previous progress for that module does not carry over.                                |

To take a course off the website, remove its menu links and choose **Unpublish** for the course in Studio. Then check that its page is no longer available. People who previously signed up stay on your marketing list unless they unsubscribe.

Unpublishing removes the course page, but uploaded files may still be available through their direct links. Ask your website team if those files also need to be removed.

## If something does not work

| What you see                                  | What to do                                                                                                                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Short Courses** is missing from Studio      | Check that you are using the Studio link provided by your team. If it is still missing, ask them to check that course editing is ready.                                |
| Studio will not let you publish               | Read the messages beside the fields. Check for missing lesson text, videos, quiz answers, or explanations, and make sure each question has exactly one correct answer. |
| The course page says it cannot be found       | Check that you published the course, typed the slug correctly, and opened the same website you are editing.                                                            |
| A video will not play                         | Check your connection and select **Retry video**. If it still fails, check that the Mux asset is ready and has Public playback enabled.                                |
| Captions are missing or out of time           | Check that the module has the correct `.vtt` file. Ask your video editor to check it against the uploaded video.                                                       |
| Signup says cookies are blocked               | Allow this website to save cookies in your browser settings, then try again. Cookies let the website remember course access.                                           |
| Signup says there have been too many attempts | Wait up to an hour before trying again. Repeated signup attempts are temporarily limited.                                                                              |
| Progress is not remembered                    | Use the same browser and device, outside private browsing. Check whether the browser is blocking or clearing saved website data.                                       |
| No welcome email arrives                      | A welcome email is not sent automatically. Ask your email marketing contact whether one has been set up.                                                               |
| Signup fails or a problem continues           | Send your website team the course link, the message you saw, and what you were doing when it happened.                                                                 |

Your website team can find setup and troubleshooting details in the [technical course guide](short-courses.md). You do not need to change those settings to add or edit course material.
