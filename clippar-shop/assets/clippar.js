  // ── Phone Carousel - Flowing rotation every 5 seconds ──
  (function() {
    const phones = [
      document.getElementById('phone-1'),
      document.getElementById('phone-2'),
      document.getElementById('phone-3')
    ];

    // The hero only renders on the landing template. Everywhere else these are
    // null and the 5-second interval below threw on phone.classList forever —
    // a repeating console error on every policy, page and cart view that would
    // bury a real one.
    if (phones.some(phone => !phone)) return;

    // Track which phone is in which position
    // positions[i] = position of phone i (0=left, 1=center, 2=right)
    let positions = [0, 1, 2];
    let isAnimating = false;
    
    function clearAnimations() {
      phones.forEach(phone => {
        phone.classList.remove('anim-right-to-left', 'anim-left-to-center', 'anim-center-to-right');
      });
    }
    
    function updatePositions() {
      const posClasses = ['pos-left', 'pos-center', 'pos-right'];
      
      phones.forEach((phone, i) => {
        phone.classList.remove('pos-left', 'pos-center', 'pos-right');
        phone.classList.add(posClasses[positions[i]]);
      });
    }
    
    function rotateClockwise() {
      if (isAnimating) return;
      isAnimating = true;
      
      // Clear any lingering animation classes
      clearAnimations();
      
      // Apply appropriate animation to each phone based on current position
      phones.forEach((phone, i) => {
        const currentPos = positions[i];
        
        if (currentPos === 2) {
          // right → left (flows under center)
          phone.classList.add('anim-right-to-left');
        } else if (currentPos === 0) {
          // left → center (rises up)
          phone.classList.add('anim-left-to-center');
        } else if (currentPos === 1) {
          // center → right (slides down)
          phone.classList.add('anim-center-to-right');
        }
      });
      
      // Update position tracking
      positions = positions.map(pos => {
        if (pos === 0) return 1; // left → center
        if (pos === 1) return 2; // center → right
        return 0; // right → left
      });
      
      // After animation completes, set final position classes and clear animations
      setTimeout(() => {
        clearAnimations();
        updatePositions();
        isAnimating = false;
      }, 1200);
    }
    
    // Start rotation every 5 seconds
    setInterval(rotateClockwise, 5000);
  })();

  // ── Spotlight glow: removed ──
  // clippargolf.com tracks the cursor across cards and paints a green radial
  // spotlight behind it. Dropped here at Henry's request. The CSS that rendered
  // it is gone from assets/clippar.css, and the [data-glow] hooks and
  // .glow-outer placeholders have been stripped from the sections, so there is
  // nothing left to bind to.

  // ── Waitlist form ──
  // The marketing site POSTs to /api/submit on Vercel (Neon + Sender.net). Here
  // the form is a {% form 'customer' %} that posts natively to /contact.
  //
  // This deliberately does NOT intercept the submit with fetch. Shopify's spam
  // protection injects a CAPTCHA token into the native submission; an async
  // fetch skips that injection and every POST comes back
  // `400 Missing CAPTCHA token`. So the job here is only to validate, fold the
  // frequency answer into the tag list, and then let the browser submit.
  //
  // Cost of that: submitting reloads the page rather than swapping the success
  // state in place, which is what clippargolf.com does. The snippet renders the
  // success state server-side on form.posted_successfully?, so the end state
  // looks the same — it just arrives via a round trip.
  //
  // Guarded: the form only renders when the hero runs in waitlist mode, and not
  // at all on product/cart templates.
  (function () {
    const form = document.getElementById('waitlist-form');
    if (!form) return;

    const btn = document.getElementById('btn-submit');
    const errorDiv = document.getElementById('form-error');
    const tagsInput = document.getElementById('f-tags');
    const frequency = document.getElementById('f-frequency');

    form.addEventListener('submit', function (e) {
      if (errorDiv) errorDiv.style.display = 'none';

      const name = document.getElementById('f-name');
      const email = document.getElementById('f-email');

      if (!name || !name.value.trim() || !email || !email.value.trim()) {
        e.preventDefault();
        if (errorDiv) {
          errorDiv.textContent = 'Name and email are required.';
          errorDiv.style.display = 'block';
        }
        return;
      }

      // Frequency has no storage field on the customer form, so fold the answer
      // into the tag list that Sender segments on. Must happen before the native
      // submit serialises the form.
      if (tagsInput && frequency && frequency.value) {
        tagsInput.value = 'waitlist, plays-' + frequency.value;
      }

      // Remember who this is. The submit is a real navigation, so the success
      // panel that comes back is a fresh page load with no idea who filled the
      // form in — and the beta click-through has to be attributable to a
      // person, not just counted. sessionStorage is the cheapest thing that
      // survives that round trip and dies with the tab.
      //
      // The tag list goes with it so the re-tag on the beta click can re-send
      // the full set (`waitlist, plays-weekly, beta-clicked`). That is correct
      // whether Shopify merges the tags it is sent or replaces them, which is
      // not worth being clever about on a live storefront.
      try {
        sessionStorage.setItem('clippar_waitlist', JSON.stringify({
          email: email.value.trim(),
          tags: tagsInput && tagsInput.value ? tagsInput.value : 'waitlist'
        }));
      } catch (err) { /* private mode, quota — tracking degrades, signup does not */ }

      if (btn) {
        btn.disabled = true;
        btn.textContent = 'SUBMITTING...';
      }
      // No preventDefault — the browser submits, CAPTCHA token included.
    });
  })();

  // ── Beta invitation: tag the customer who clicks through ──
  //
  // The success panel invites the signup to try the app. Henry needs to know
  // *who* took that up, so the click adds `beta-clicked` to the same customer.
  //
  // Same hard rule as the form above, arrived at from the other side: Shopify's
  // spam protection listens for a `submit` **event** on document. A programmatic
  // `form.submit()` fires no such event, so the hCaptcha token is never attached
  // and the POST comes back `400 Missing CAPTCHA token`. `requestSubmit()` fires
  // a real one. The hidden form also carries `data-shopify-captcha="true"`, which
  // makes the bootstrap bind it at DOMContentLoaded rather than on first submit,
  // so the token is already in place before the visitor taps.
  //
  // Nothing here can stop the App Store link opening: the CTA is a plain anchor
  // and this never calls preventDefault. Worst case the tag is missed and the
  // visitor still lands on the listing.
  (function () {
    const cta = document.getElementById('beta-cta');
    const tagForm = document.getElementById('beta-tag-form');
    if (!cta || !tagForm) return;

    const emailField = document.getElementById('beta-tag-email');
    const tagsField = document.getElementById('beta-tag-tags');
    if (!emailField || !tagsField) return;

    // target= as an attribute on {% form %} is not guaranteed to survive, and a
    // form that posts in the top frame would navigate the visitor off the panel
    // mid-click. Set it here too so it cannot be missed.
    tagForm.target = 'beta-tag-sink';

    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem('clippar_waitlist') || 'null'); } catch (err) {}

    // Prefer whatever Shopify rendered into the field ({{ form.email }}); fall
    // back to what the visitor typed on the previous page view.
    const email = (emailField.value || '').trim() || (saved && saved.email) || '';
    const baseTags = (saved && saved.tags) || 'waitlist';

    if (!email) {
      // Cannot attribute the click to anyone, so do not pretend to. The link
      // still works; the tag is simply not written.
      return;
    }

    emailField.value = email;
    tagsField.value = baseTags + ', beta-clicked';

    cta.addEventListener('click', function () {
      if (cta.dataset.betaTagged === '1') return;
      cta.dataset.betaTagged = '1';
      try {
        if (typeof tagForm.requestSubmit === 'function') {
          tagForm.requestSubmit();
        } else {
          tagForm.submit();
        }
      } catch (err) { /* never block the navigation */ }
    });
  })();

  // ── Contact form ──
  //
  // Two fields are only relevant to some enquiries, so they are hidden until
  // the topic calls for them. They render visible in the markup and are hidden
  // here, which means a customer with JS off sees two extra optional fields
  // rather than a form missing the box they were told to fill in.
  //
  // Same rule as the waitlist form: never preventDefault on the valid path, or
  // Shopify's spam-protection token is never attached.
  (function () {
    const form = document.getElementById('contact-form');
    if (!form) return;

    const topic = document.getElementById('c-topic');
    const otherGroup = document.getElementById('c-other-group');
    const orderGroup = document.getElementById('c-order-group');
    const btn = document.getElementById('c-submit');
    const errorDiv = document.getElementById('contact-error');

    // Topics where an order number is worth asking for. Values must match the
    // <option> values in sections/contact-form.liquid.
    const ORDER_TOPICS = [
      'Order or delivery',
      'Return, refund or fault',
      'Safety issue (URGENT)'
    ];

    // Hiding a field is not enough: a hidden input still posts, and Shopify
    // renders every contact[...] field it receives as a labelled line, so an
    // App support enquiry arrived with a blank "Order Number:" under it.
    // Disabling keeps the field out of the submission entirely.
    function toggle(group, show) {
      if (!group) return;
      group.hidden = !show;
      const field = group.querySelector('input, textarea, select');
      if (field) field.disabled = !show;
    }

    function sync() {
      const value = topic ? topic.value : '';
      toggle(otherGroup, value === 'Other');
      toggle(orderGroup, ORDER_TOPICS.indexOf(value) !== -1);
    }

    if (topic) topic.addEventListener('change', sync);
    sync();

    // Two cheap bot traps. Neither is a wall: Shopify owns the endpoint, so
    // everything here is client-side and a script that POSTs straight to
    // /contact skips it entirely. What makes them worth having is that such a
    // POST has no spam-protection token and Shopify rejects it — so the bots
    // that get through are driving a real browser, and a real browser runs this.
    const loadedAt = Date.now();
    const MIN_FILL_MS = 3000;
    const honeypot = document.getElementById('c-hp');

    form.addEventListener('submit', function (e) {
      // A blanket-filler takes the off-screen field; a person never sees it.
      // Fail silently — telling a bot which check it tripped just teaches it.
      if (honeypot && honeypot.value) {
        e.preventDefault();
        return;
      }

      // Nobody types a name, an email, a topic and a message in three seconds.
      if (Date.now() - loadedAt < MIN_FILL_MS) {
        e.preventDefault();
        return;
      }

      if (errorDiv) errorDiv.style.display = 'none';

      const email = document.getElementById('c-email');
      const body = document.getElementById('c-body');

      if (!email || !email.value.trim() || !body || !body.value.trim()) {
        e.preventDefault();
        if (errorDiv) {
          errorDiv.textContent = 'Email and message are required.';
          errorDiv.style.display = 'block';
        }
        return;
      }

      // A shown-but-blank optional field still posts, and Shopify renders every
      // contact[...] field it receives as a labelled heading — so choosing
      // "Other" and skipping the topic produced a bare "Other Topic:" with
      // nothing under it. Drop empties on the way out.
      [otherGroup, orderGroup].forEach(function (group) {
        if (!group || group.hidden) return;
        const field = group.querySelector('input, textarea, select');
        if (field && !field.value.trim()) field.disabled = true;
      });

      if (btn) {
        btn.disabled = true;
        btn.textContent = 'SENDING...';
      }
    });
  })();

  // ── Product page: compatibility gate ──
  //
  // The kit needs an iPhone and the reels need Pro. Both are stated above the
  // button, but a notice someone can scroll past is a weak defence — the
  // checkbox turns it into an acknowledgement that has to be made before money
  // can move.
  //
  // Note the dynamic checkout button is gated too. "Buy it now" goes straight
  // to checkout without touching the cart, so gating only add-to-cart would
  // leave the fastest path to payment completely open.
  (function () {
    const ack = document.getElementById('pdp-compat-ack');
    if (!ack) return;

    const btn = document.getElementById('pdp-add-btn');
    const dynamic = document.getElementById('pdp-dynamic-checkout');

    function sync() {
      if (btn) btn.disabled = !ack.checked;
      if (dynamic) dynamic.classList.toggle('pdp-dynamic-disabled', !ack.checked);
    }

    ack.addEventListener('change', sync);
    sync();
  })();

  // ── Scroll animations ──
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.style.opacity = '1';
        entry.target.style.transform = 'translateY(0)';
      }
    });
  }, { threshold: 0.1 });

  document.querySelectorAll('.folder, .demo-card, .gallery-item, .tech-pill').forEach(el => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(20px)';
    el.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
    observer.observe(el);
  });

  // ── Steps Carousel ──
  (function() {
    const track = document.getElementById('steps-track');
    const dots = document.querySelectorAll('.carousel-dot');
    const prevBtn = document.getElementById('prev-btn');
    const nextBtn = document.getElementById('next-btn');
    const progressBar = document.getElementById('carousel-progress');
    const section = document.getElementById('how-it-works');
    const videos = document.querySelectorAll('.step-video');

    // The storefront renders the steps as a static grid rather than a carousel,
    // so these elements are absent. Bail out instead of throwing.
    if (!track || !prevBtn || !nextBtn || !progressBar || !section) return;
    
    let currentIndex = 0;
    let isInView = false;
    const totalSlides = 3;
    
    function stopAllVideos() {
      videos.forEach(v => {
        v.pause();
        v.currentTime = 0.1; // Seek to 0.1 not 0 — ensures a visible frame is painted (no black)
      });
    }

    function playCurrentVideo() {
      const video = videos[currentIndex];
      video.currentTime = 0.1; // Start just past 0 to avoid black first-frame on some browsers
      video.play().catch(() => {});
    }
    
    function updateProgressBar() {
      const video = videos[currentIndex];
      if (video.duration && isFinite(video.duration)) {
        const durationMs = video.duration * 1000;
        progressBar.style.transition = 'none';
        progressBar.style.width = '0%';
        progressBar.offsetHeight; // Force reflow
        progressBar.style.transition = `width ${durationMs}ms linear`;
        progressBar.style.width = '100%';
      }
    }
    
    function goToSlide(index) {
      currentIndex = index;
      track.style.transform = `translateX(-${index * 100}%)`;
      
      // Update dots
      dots.forEach((dot, i) => {
        dot.classList.toggle('active', i === index);
      });
      
      // Stop all videos, play current one
      stopAllVideos();
      if (isInView) {
        playCurrentVideo();
      }
    }
    
    function nextSlide() {
      goToSlide((currentIndex + 1) % totalSlides);
    }
    
    function prevSlide() {
      goToSlide((currentIndex - 1 + totalSlides) % totalSlides);
    }
    
    // Listen for video ended events - auto-advance to next slide
    videos.forEach((video, i) => {
      video.addEventListener('ended', () => {
        if (isInView && i === currentIndex) {
          nextSlide();
        }
      });
      
      // Update progress bar once video metadata is loaded
      video.addEventListener('loadedmetadata', () => {
        if (i === currentIndex && isInView) {
          updateProgressBar();
        }
      });
      
      // Update progress bar on play
      video.addEventListener('play', () => {
        if (i === currentIndex) {
          updateProgressBar();
        }
      });
    });
    
    // Dot click handlers
    dots.forEach((dot, i) => {
      dot.addEventListener('click', () => {
        goToSlide(i);
      });
    });
    
    // Arrow click handlers
    prevBtn.addEventListener('click', () => {
      prevSlide();
    });
    
    nextBtn.addEventListener('click', () => {
      nextSlide();
    });
    
    // Touch/swipe support - listen on carousel container for better touch area
    let touchStartX = 0;
    let touchStartY = 0;
    let isSwiping = false;
    
    const carousel = document.querySelector('.steps-carousel');
    
    carousel.addEventListener('touchstart', e => {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      isSwiping = false;
    }, { passive: true });
    
    carousel.addEventListener('touchmove', e => {
      if (!touchStartX) return;
      const diffX = Math.abs(e.touches[0].clientX - touchStartX);
      const diffY = Math.abs(e.touches[0].clientY - touchStartY);
      // If horizontal movement is greater than vertical, we're swiping
      if (diffX > diffY && diffX > 10) {
        isSwiping = true;
      }
    }, { passive: true });
    
    carousel.addEventListener('touchend', e => {
      const touchEndX = e.changedTouches[0].clientX;
      const diff = touchStartX - touchEndX;
      
      // Only trigger if it was a horizontal swipe with enough distance
      if (isSwiping && Math.abs(diff) > 50) {
        if (diff > 0) {
          nextSlide();
        } else {
          prevSlide();
        }
      }
      touchStartX = 0;
      touchStartY = 0;
      isSwiping = false;
    }, { passive: true });
    
    // Start/stop video when section comes into view
    const carouselObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          isInView = true;
          playCurrentVideo();
        } else {
          isInView = false;
          stopAllVideos();
          progressBar.style.transition = 'none';
          progressBar.style.width = '0%';
        }
      });
    }, { threshold: 0.3 });
    
    carouselObserver.observe(section);
  })();

  // ── Video loading, deferred until a clip is actually near the viewport ──
  //
  // This block used to be titled "Aggressive video preload" and did what it
  // said: forced `preload='auto'` on every <video> on the page, overriding the
  // markup, then called .load() on all of them immediately.
  //
  // Measured cost on mobile: 6,784 KB of a 6,791 KB page — 99.9% of everything
  // transferred — including a 2.6 MB clip that sits below the fold and most
  // visitors never scroll to. It also meant no `preload` attribute anywhere in
  // the theme had any effect, so the obvious fix (setting preload="none" in the
  // Liquid) silently did nothing.
  //
  // Now: nothing loads until a clip is within 200px of the viewport, at which
  // point it loads AND plays. Below-the-fold video costs zero bytes to someone
  // who never scrolls.
  //
  // The first-frame seek is kept. Without it the phone mockups paint black,
  // which is a defect we have already chased once.
  (function() {
    const ALL_VIDEOS = document.querySelectorAll('video');
    const phoneVideos = document.querySelectorAll('.phone-frame video');
    const stepVideos = document.querySelectorAll('.step-video');
    if (!ALL_VIDEOS.length) return;

    // WCAG 2.2.2: anything that moves for more than five seconds needs a way to
    // stop it, and a looping video never stops on its own. Someone who has asked
    // their OS for less motion gets the poster frame and nothing moving.
    const reduceQuery = window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : { matches: false, addEventListener: null };
    const wantsStill = () => reduceQuery.matches;

    // Mobile browsers refuse to play unmuted video without a gesture. This is a
    // playback requirement, not a preload one, so it is safe to set up front.
    ALL_VIDEOS.forEach(video => {
      video.muted = true;
      video.setAttribute('playsinline', '');
    });

    function paintFirstFrame(video) {
      if (video.readyState >= 2 && video.paused) {
        try { video.currentTime = 0.1; } catch (e) {}
      }
    }

    // Load-on-demand. Deliberately does NOT touch videos that are still far
    // away — that restraint is the entire point of this rewrite.
    // Playback is opt-in, via `data-autoplay` in the markup (or a real
    // `autoplay` attribute). It is NOT "anything that scrolls into view" — the
    // product page renders Shopify's own video_tag with controls, and a product
    // video that starts playing by itself as the buyer scrolls past is a
    // nuisance, not a feature.
    function wantsPlayback(video) {
      return video.hasAttribute('data-autoplay') || video.autoplay;
    }

    function activate(video) {
      if (!video.dataset.clipparLoaded) {
        video.dataset.clipparLoaded = '1';
        // The markup's preload is the author's intent for the initial document.
        // Once the clip is actually on screen we do want the data.
        video.preload = 'auto';
        video.load();
        video.addEventListener('loadeddata', () => paintFirstFrame(video), { once: true });
      }
      if (!wantsPlayback(video) || wantsStill()) { video.pause(); return; }
      const p = video.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }

    // Whatever is already on screen starts without waiting for the observer.
    //
    // IntersectionObserver needs layout and paint to compute an intersection,
    // so in an environment where the page never renders it delivers no
    // callbacks at all — verified: a fresh observer on these same elements
    // fired zero times in a background tab. Relying on it alone makes it a
    // single point of failure for the hero ever playing.
    //
    // This still loads nothing below the fold; it only covers what is visible.
    function activateVisible() {
      ALL_VIDEOS.forEach(video => {
        const r = video.getBoundingClientRect();
        if (r.top < window.innerHeight && r.bottom > 0) activate(video);
      });
    }

    activateVisible();

    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) activate(entry.target);
          else if (wantsPlayback(entry.target)) entry.target.pause();
        });
      }, { threshold: 0.05, rootMargin: '200px' });

      ALL_VIDEOS.forEach(v => observer.observe(v));
    } else {
      // No observer at all: a cheap scroll handler covers the rest.
      window.addEventListener('scroll', activateVisible, { passive: true });
    }

    // iOS Safari can still refuse the first play() until a gesture happens.
    // Retry once, for clips already on screen only.
    const retryPlay = () => {
      if (wantsStill()) return;
      phoneVideos.forEach(video => {
        const r = video.getBoundingClientRect();
        if (r.top < window.innerHeight && r.bottom > 0 && video.paused) {
          const p = video.play();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        }
      });
    };
    document.addEventListener('touchstart', retryPlay, { once: true, passive: true });
    document.addEventListener('click', retryPlay, { once: true });

    if (reduceQuery.addEventListener) {
      reduceQuery.addEventListener('change', (e) => {
        if (e.matches) ALL_VIDEOS.forEach(v => v.pause());
        else retryPlay();
      });
    }

    // Step carousel clips paint their first frame once loaded, same as before.
    stepVideos.forEach(video => {
      video.addEventListener('canplaythrough', () => paintFirstFrame(video), { once: true });
    });
  })();
