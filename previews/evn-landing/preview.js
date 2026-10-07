/* Local UI only: deliberately has no fetch, beacon, storage or production scripts. */
(() => {
  const all = (selector, root = document) => [...root.querySelectorAll(selector)]
  const textControls = (label, root = document) => all('span,div', root).filter(el => el.textContent.trim() === label && ![...el.children].some(c => c.textContent.trim() === label))
  function control(el, action, label) {
    el.setAttribute('role', 'button'); el.tabIndex = 0
    if (label) el.setAttribute('aria-label', label)
    el.style.cursor = 'pointer'
    el.addEventListener('click', action)
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); action() } })
  }
  function scrollToSection(id) {
    const target = document.getElementById(id)
    if (target) window.scrollTo({top: Math.max(0, target.getBoundingClientRect().top + scrollY - (innerWidth < 768 ? 70 : 80)), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'})
  }
  const header = document.querySelector('[class*="Header_Header"]')
  for (const [label, id] of Object.entries({'회사소개':'company','차량소개':'car','맞춤 설계':'custom','상담 신청':'contact'})) {
    textControls(label, header).forEach(el => control(el, () => scrollToSection(id)))
  }
  all('img', header).forEach(el => control(el, () => scrollToSection('contact'), '맨 위로'))
  textControls('보조금 계산', header).forEach(el => control(el, () => openModal('subsidy')))
  textControls('확인하기').forEach(el => control(el, () => scrollToSection('contact')))
  textControls('빠른 상담').forEach(el => control(el.parentElement.parentElement, () => {
    const form = all('#contact form').find(el => el.getBoundingClientRect().width)
    form?.scrollIntoView({behavior:'smooth', block:'center'})
  }, '빠른 상담'))
  textControls('전화상담').forEach(el => control(el.parentElement.parentElement, () => openMessage('전화상담 시연', '이 화면은 로컬 미리보기입니다. 실제 전화 연결은 실행하지 않습니다.'), '전화상담 시연'))

  function modalShell(label) {
    const dialog = document.createElement('dialog')
    dialog.className = 'preview-dialog'
    dialog.setAttribute('aria-label', label)
    const previous = document.activeElement
    const close = document.createElement('button'); close.type = 'button'; close.className = 'preview-close'; close.textContent = '×'; close.setAttribute('aria-label', '닫기')
    close.addEventListener('click', () => dialog.close())
    dialog.append(close)
    dialog.addEventListener('click', e => { const r = dialog.getBoundingClientRect(); if(e.target === dialog && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) dialog.close() })
    dialog.addEventListener('close', () => { dialog.remove(); if (!document.querySelector('dialog[open]')) document.body.style.overflow = ''; previous?.focus() })
    document.body.append(dialog)
    return dialog
  }
  function show(dialog) { dialog.showModal(); document.body.style.overflow = 'hidden' }
  function openModal(kind) {
    const dialog = modalShell(kind === 'privacy' ? '개인정보 수집·이용 안내' : '실구매가 & 보조금 조회하기')
    const template = document.getElementById(`${kind}-template`)
    const content = template.content.firstElementChild.cloneNode(true)
    content.classList.remove('Modal_Content__0TvVc', 'Modal_Open__zpm6G')
    content.classList.add('preview-modal-content')
    dialog.classList.add(`preview-${kind}`)
    dialog.append(content)
    if (kind === 'subsidy') {
      const trigger = content.querySelector('[class*="selectB_trigger"]')
      const select = document.createElement('select'); select.name = 'region'; select.setAttribute('aria-label', '지역 선택'); select.className = 'preview-region'
      for (const value of ['', '서울', '경기', '인천']) { const option = document.createElement('option'); option.value = value; option.textContent = value || '선택'; select.append(option) }
      trigger.replaceWith(select)
      setupForms(content)
    } else {
      const note = document.createElement('p'); note.className = 'preview-policy-note'; note.textContent = '원본 사이트의 안내문을 재현한 화면입니다. 로컬 시연에서는 개인정보를 저장하거나 전송하지 않습니다.'
      content.querySelector('[class*="ModalContent"]').prepend(note)
      all('[class*="ModalHeaderContent"] img, [class*="ModalHeaderContent"] svg', content).forEach(el => el.remove())
    }
    setupPrivacy(content)
    show(dialog)
  }
  function openMessage(title, message) {
    const dialog = modalShell(title)
    dialog.classList.add('preview-message')
    const heading = document.createElement('h2'); heading.textContent = title
    const paragraph = document.createElement('p'); paragraph.textContent = message
    const ok = document.createElement('button'); ok.type = 'button'; ok.textContent = '확인'; ok.addEventListener('click', () => dialog.close())
    dialog.append(heading, paragraph, ok); show(dialog)
  }
  function setupPrivacy(root) { textControls('내용보기', root).forEach(el => control(el, () => openModal('privacy'))) }
  function setupForms(root) {
    all('button', root).filter(el => el.textContent.trim() === '간편 상담신청').forEach(button => {
      let box = button.parentElement
      while (box && !box.querySelector('input[type="text"],input:not([type])')) box = box.parentElement
      if (!box || box.tagName === 'FORM') return
      const form = document.createElement('form')
      for (const attr of box.attributes) form.setAttribute(attr.name, attr.value)
      form.classList.add('preview-form'); form.noValidate = true
      while (box.firstChild) form.append(box.firstChild)
      box.replaceWith(form)
      const inputs = all('input', form).filter(el => el.type !== 'checkbox')
      inputs.forEach((input, index) => {
        input.required = true
        input.name = ['name','phonePrefix','phoneMiddle','phoneLast'][index]
        input.setAttribute('aria-label', ['이름','연락처 앞자리','연락처 가운데자리','연락처 뒷자리'][index])
        input.autocomplete = 'off'
        if (index > 0) {
          input.type = 'tel'; input.inputMode = 'numeric'; input.pattern = index === 1 ? '01[016789]' : index === 2 ? '[0-9]{3,4}' : '[0-9]{4}'
          input.addEventListener('input', () => { input.value = input.value.replace(/\D/g,'').slice(0,index===1?3:4); if(input.value.length===4&&index===2)inputs[3].focus() })
        } else { input.maxLength=50; input.autocomplete='name' }
      })
      const consent = form.querySelector('input[type="checkbox"]')
      if(consent) { consent.required=true; consent.name='privacy'; consent.setAttribute('aria-label','개인정보 수집 및 이용 동의') }
      const status=document.createElement('p');status.className='preview-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.hidden=true
      button.parentElement.append(status)
      button.type = 'submit'
      form.addEventListener('submit', event => {
        event.preventDefault()
        inputs[0].setCustomValidity(inputs[0].value.trim() ? '' : '이름을 입력해 주세요.')
        const invalid=all('input',form).find(input=>!input.checkValidity())
        if(invalid) {
          status.textContent=invalid===consent?'개인정보 수집 및 이용 동의를 확인해 주세요.':invalid===inputs[0]?'이름을 입력해 주세요.':'연락처를 확인해 주세요. (예: 010-0000-0000)'
          status.hidden=false;status.dataset.state='error';invalid.focus();return
        }
        status.textContent='입력 확인이 완료되었습니다. 로컬 시연이므로 상담 신청은 저장·전송되지 않았습니다.'
        status.hidden=false;status.dataset.state='success'
      })
      inputs[0].addEventListener('input',()=>inputs[0].setCustomValidity(''))
    })
  }
  setupForms(document)
  setupPrivacy(document)

  // The original review carousel uses Swiper. Native scroll snapping preserves
  // the same card sizes without importing its production bundle or trackers.
  all('.swiper').forEach(slider => {
    slider.classList.add('preview-slider'); slider.tabIndex=0;slider.setAttribute('role','region');slider.setAttribute('aria-label','기사님 후기 슬라이더')
    const wrapper=slider.querySelector('.swiper-wrapper');wrapper.style.transform='none'
    let paused=false
    slider.addEventListener('pointerenter',()=>{paused=true});slider.addEventListener('pointerleave',()=>{paused=false})
    slider.addEventListener('focusin',()=>{paused=true});slider.addEventListener('focusout',()=>{paused=false})
    const advance = direction => { const card=wrapper.firstElementChild; const gap=innerWidth<768?20:26; const step=card.getBoundingClientRect().width+gap; slider.scrollTo({left:slider.scrollLeft>=slider.scrollWidth-slider.clientWidth-2&&direction>0?0:slider.scrollLeft+direction*step,behavior:'smooth'}) }
    slider.addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();advance(e.key==='ArrowRight'?1:-1)}})
    if(!matchMedia('(prefers-reduced-motion: reduce)').matches) setInterval(()=>{if(!paused&&!document.hidden&&slider.getBoundingClientRect().width)advance(1)},3000)
  })
  const note=document.createElement('p');note.className='preview-footer-note';note.textContent='로컬 시연 · 상담 신청은 저장·전송되지 않습니다.'
  document.querySelector('[class*="footerAp_footerContent"]')?.append(note)
})()
