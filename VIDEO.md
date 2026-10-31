# OrangeFile presentation video: "Ora in the Citrus Studio"

About 60 seconds, 16:9 for the landing page (plus a 30-second 9:16 cut for Reels/TikTok). French and English versions.
The landing page shows it automatically once the files are in `web/public/video/` (see the README there).

## Style
- **Presenter:** Ora, an original stylized 3D woman (premium animated-film look). Short dark curly hair, warm brown skin,
  tangerine cropped jacket over a cream top, mint earrings and sneakers. Friendly, confident, a little playful.
- **World:** glossy 3D studio in the site's colours: tangerine `#FF6B1A`, aubergine `#2B0F2E`, cream `#FFF3E8`, mint `#9EE6CF`
  only for "done" moments.
- **Recurring visual:** the file press from the landing page, in 3D. A file goes in and comes out converted, stamped DONE in mint.
- **Voice:** warm, clear, never pushy. Music: light, bouncy, low under the voice.

## Script
| # | Time | Visual | EN | FR |
|---|---|---|---|---|
| 1 | 0–4 s | JPG, DOCX, PDF and ZIP icons tumble from the sky; Ora catches one, grinning | Wrong format… again? | Encore le mauvais format ? |
| 2 | 4–9 s | Ora steps forward, OrangeFile logo lights up behind her | I'm Ora, from OrangeFile. Free, no account, right in your browser. | Moi c'est Ora, d'OrangeFile. Gratuit, sans compte, directement dans votre navigateur. |
| 3 | 9–16 s | A PNG card goes into the press, comes out a JPG, stamped DONE | Convert pictures between JPG, PNG and WebP. | Convertissez vos images entre JPG, PNG et WebP. |
| 4 | 16–23 s | A heavy 4 MB photo block is squeezed thin; a gauge drops to 300 KB | Too heavy to send? Pick a size, and it fits. | Trop lourde pour l'envoyer ? Choisissez un poids, elle rentre. |
| 5 | 23–29 s | Three PDF sheets fly together into one; then one splits into three | Merge PDFs… or split them apart. | Fusionnez vos PDF… ou divisez-les. |
| 6 | 29–37 s | A giant PDF page: pages shuffle like cards, a highlighter swipes, a pen signs | Reorder pages, annotate, and sign — in seconds. | Réorganisez les pages, annotez, signez — en quelques secondes. |
| 7 | 37–43 s | Word, Excel and PowerPoint blocks melt into clean PDF pages | Word, Excel, PowerPoint? One click to PDF. | Word, Excel, PowerPoint ? Un clic, et c'est un PDF. |
| 8 | 43–48 s | A folder zips up like a jacket into a glowing ZIP cube | Zip a whole folder, or open one safely. | Zippez un dossier entier, ou ouvrez-en un en toute sécurité. |
| 9 | 48–55 s | Files dissolve into mint sparkles while a timer counts from 15:00 | And your files? Deleted after 15 minutes. We don't keep them. | Et vos fichiers ? Supprimés après 15 minutes. On ne les garde pas. |
| 10 | 55–60 s | Ora points at the address; logo lockup with the URL and "100 MB per file" | OrangeFile. The file you have — into the one you need. | OrangeFile. Votre fichier, dans le format qu'il vous faut. |

Captions: `web/public/video/orangefile-en.vtt` and `orangefile-fr.vtt` (adjust the times to the final edit).

## Production with Higgsfield (needs the Basic plan or higher)
1. **Ora's character sheet** (`gpt_image_2_5`, about 0.25 credits each). Prompt:
   "Character design sheet of 'Ora', an original stylized 3D animated woman presenter in a premium animated-feature-film style:
   friendly, confident, early 30s, short dark curly hair, warm brown skin, expressive eyes, tangerine-orange cropped jacket over a
   cream top, small mint-green earrings and mint sneakers. Front, three-quarter and side views plus two expression close-ups.
   Soft studio lighting, warm cream background (#FFF3E8), tangerine (#FF6B1A) accents, aubergine (#2B0F2E) shadows. No text."
2. **Voice** (text-to-speech), one track per language, from the script above.
3. **Talking shots, scenes 2 and 10:** Higgsfield Intone (Ora's image + the voice track, lip-synced).
4. **3D shots, scenes 1 and 3–9:** Seedance 2.5, about 35 credits per 5 s at 720p. Make 480p drafts first, finalize the keepers.
   Each prompt starts with: "Glossy stylized 3D animation, tangerine studio background, aubergine shadows, soft studio light,
   mint accents, smooth camera move," followed by the scene's visual from the table.
5. **Edit with Katana:** cuts on the voice, on-screen text (tool names, URL), music, and the 9:16 cut.
6. Export H.264/AAC MP4, under about 20 MB, as `orangefile-en.mp4` / `orangefile-fr.mp4`, plus a 16:9 poster `orangefile-poster.jpg`.

Rough budget: 350–450 credits for both languages at 720p (exact quote before generating).
