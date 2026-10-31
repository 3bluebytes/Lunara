// No browser, resource loader or network APIs. A separate worker makes even
// synchronous adversarial DOM parsing cancellable without blocking chat/playback.
import { parentPort, workerData } from 'node:worker_threads';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
try {
  const { document } = parseHTML(workerData.html);
  if (document.querySelector('input[type="password"], #challenge-form, .g-recaptcha, .h-captcha')) {
    parentPort.postMessage({ unavailable:true });
  } else {
    for (const element of document.querySelectorAll('script,style,iframe,object,embed,svg,form,nav,footer,header,noscript')) element.remove();
    const article = new Readability(document, { charThreshold:80, maxElemsToParse:30000 }).parse();
    const text = String(article?.textContent || '').replace(/\s+/g,' ').trim();
    parentPort.postMessage(text ? { title:String(article.title || document.title || ''),text } : { unavailable:true });
  }
} catch { parentPort.postMessage({ unavailable:true }); }
