// The reading view. A share link opened here renders a finished page — covers, hover cards,
// working links — instead of an editor full of toolbars.
//
// Everything it needs arrives in the fragment, so this page fetches nothing, writes nothing to
// browser storage, and puts no user content on the server. That is the whole point: a list can
// be handed to a stranger with a URL and no service has to exist to hold it.

import { decodeDoc, fragmentPayload, PREFIX } from '../io/share.js';
import { boardHtml } from '../render/page.js';

const $ = (sel) => document.querySelector(sel);

function fail(title, body) {
  $('#v-title').textContent = 'booktier';
  $('#v-error-title').textContent = title;
  $('#v-error-body').textContent = body;
  $('#v-error').hidden = false;
}

async function boot() {
  const payload = fragmentPayload();
  if (!payload) {
    fail('There is no list in this link',
      'A booktier reading link carries the whole list after the # in the address. This one has '
      + 'nothing after it — the link was probably cut short when it was copied or pasted.');
    return;
  }

  let doc;
  try {
    doc = await decodeDoc(payload);
  } catch (err) {
    fail('This list could not be opened', `${err.message}. If the link came from a chat app or a `
      + 'comment, it may have been truncated — ask for it again as a whole.');
    return;
  }

  // These are someone else's links rendered on booktier.org, so they get the treatment any site
  // gives user-submitted links: no link equity, and marked as user-generated. A page the user
  // exports and hosts themselves keeps passing equity, because there it is their own site.
  doc = { ...doc, render: { ...doc.render, rel: `${doc.render.rel} nofollow ugc` } };

  document.title = doc.title ? `${doc.title} — booktier` : 'A tier list — booktier';
  $('#v-title').textContent = doc.title || 'Untitled tier list';
  if (doc.subtitle) { $('#v-sub').textContent = doc.subtitle; $('#v-sub').hidden = false; }

  // inlineStyles:false keeps style attributes out of the markup so this page runs under a CSP
  // with no unsafe-inline; the tier colors go on through the CSSOM, which CSP does not treat as
  // an inline style.
  const board = $('#v-board');
  board.innerHTML = boardHtml(doc, { editable: false, inlineStyles: false });
  for (const label of board.querySelectorAll('.bt-rowlabel[data-color]')) {
    label.style.backgroundColor = label.dataset.color;
  }

  // Forking is just the same payload handed to the editor, which already treats a fragment as
  // "someone else's list" and sets the reader's own list aside before loading it.
  $('#v-fork').setAttribute('href', `../app/${PREFIX}${payload}`);
  $('#v-foot').hidden = false;
}

boot();
