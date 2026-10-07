import fs from 'node:fs/promises'
import path from 'node:path'

const source = path.resolve('previews/evn-landing')
const output = path.resolve('public/landing')
await fs.mkdir(output, { recursive: true })
await fs.cp(path.join(source, 'assets'), path.join(output, 'assets'), { recursive: true })
const replaceOnce = (text, before, after) => {
  if (!text.includes(before)) throw new Error('Landing source changed; review public form transform')
  return text.replace(before, after)
}
let html = await fs.readFile(path.join(source, 'index.html'), 'utf8')
html = replaceOnce(html, 'EV&amp;Solution | 로컬 미리보기', 'EV&amp;Solution | PV5 상담 신청')
const policy = `이브이앤솔루션 주식회사 개인정보 수집·이용 안내

1. 목적: PV5 차량 구매·보조금 상담 신청 접수, 신청 내용 확인 및 상담 연락
2. 수집 항목: 이름, 연락처. 보조금 상담 신청 시 선택한 지역(서울·경기·인천), 상담 종류, 접수 시각, 동의한 안내문 버전 및 동의 시각
3. 보유·이용 기간: 상담 처리 목적을 달성하거나 동의를 철회하면 지체 없이 파기합니다. 다른 법령에 따라 보존해야 하는 기록이 발생한 경우 해당 법령이 정한 항목과 기간에 한해 별도로 분리 보관합니다.
4. 동의 거부: 개인정보 수집·이용에 동의하지 않을 수 있습니다. 동의하지 않으면 이 온라인 상담 신청을 접수할 수 없습니다.
5. 열람·정정·삭제 및 동의 철회 문의: 이브이앤솔루션 주식회사, 050-8201-0835

이 신청의 동의는 위 상담을 위한 것입니다. 광고성 정보 수신 동의를 포함하지 않습니다.
안내문 버전: 2026-10-07-v1`
html = html.replace(/<template id="privacy-template">[\s\S]*?<\/template>/, `<template id="privacy-template"><section class="public-privacy"><h2>개인정보 수집·이용 안내</h2><div class="ModalContent"><pre>${policy}</pre></div></section></template>`)
if (/루센트|채용 상담/.test(html)) throw new Error('Old privacy policy remains')
const csp = "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'"
html = html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`)
let js = await fs.readFile(path.join(source, 'preview.js'), 'utf8')
js = replaceOnce(js, '/* Local UI only: deliberately has no fetch, beacon, storage or production scripts. */', '/* Generated public form. No third-party trackers or client-side secrets. */')
js = replaceOnce(js, "() => openMessage('전화상담 시연', '이 화면은 로컬 미리보기입니다. 실제 전화 연결은 실행하지 않습니다.'), '전화상담 시연'", "() => { location.href = 'tel:05082010835' }, '전화상담'")
js = js.replace(/      const note = document\.createElement\('p'\); note\.className = 'preview-policy-note';[^\n]+\n      content\.querySelector\([^\n]+\n/, '')
js = replaceOnce(js, "      button.type = 'submit'", `      button.type = 'submit'
      let submissionId = crypto.randomUUID(), submittedPayload = null, pending = false, saved = false
      const trap = document.createElement('input'); trap.name = 'website'; trap.type = 'text'; trap.tabIndex = -1; trap.autocomplete = 'off'; trap.className = 'public-honeypot'; trap.setAttribute('aria-hidden', 'true'); form.append(trap)`)
js = replaceOnce(js, "form.addEventListener('submit', event => {", "form.addEventListener('submit', async event => {")
js = replaceOnce(js, '        event.preventDefault()', '        event.preventDefault()\n        if (pending || saved) return')
js = replaceOnce(js, "        const invalid=all('input',form).find(input=>!input.checkValidity())", `        inputs[1].setCustomValidity(inputs[1].value === '010' && inputs[2].value.length !== 4 ? '010 번호의 가운데 자리는 4자리입니다.' : '')
        const region = form.querySelector('select[name="region"]')
        if (region && !region.value) { status.textContent='지역을 선택해 주세요.'; status.hidden=false; status.dataset.state='error'; region.focus(); return }
        const invalid=all('input',form).find(input=>!input.checkValidity())`)
js = replaceOnce(js, "        status.textContent='입력 확인이 완료되었습니다. 로컬 시연이므로 상담 신청은 저장·전송되지 않았습니다.'\n        status.hidden=false;status.dataset.state='success'", `        const values = { name: inputs[0].value.trim(), phone: inputs.slice(1).map(input => input.value).join(''), kind: region ? 'subsidy' : 'consultation', region: region?.value || null, consent: consent.checked, policyVersion: '2026-10-07-v1', website: trap.value }
        const snapshot = JSON.stringify(values)
        if (submittedPayload && submittedPayload !== snapshot) submissionId = crypto.randomUUID()
        submittedPayload = snapshot
        pending = true; button.disabled = true; button.textContent = '접수 중…'; form.setAttribute('aria-busy', 'true')
        status.textContent = '상담 신청을 저장하고 있습니다.'; status.hidden = false; status.dataset.state = 'pending'
        try {
          const response = await fetch('/api/external/landing-inquiries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...values, submissionId }), credentials: 'omit', signal: AbortSignal.timeout(15000) })
          const result = await response.json()
          if (!response.ok || result.ok !== true || result.receipt !== submissionId) throw new Error(result.error || '접수 결과를 확인하지 못했습니다. 다시 시도해 주세요.')
          saved = true; status.textContent = '상담 신청이 접수되었습니다. 담당자가 연락드리겠습니다.'; status.dataset.state = 'success'; button.textContent = '접수 완료'
        } catch (error) {
          status.textContent = error.name === 'TimeoutError' || error.name === 'TypeError' ? '접수 결과를 확인하지 못했습니다. 입력 내용을 유지한 채 다시 눌러 주세요. 같은 신청은 한 번만 저장됩니다.' : error.message
          status.dataset.state = 'error'; button.textContent = '다시 신청하기'
        } finally { pending = false; button.disabled = saved; form.removeAttribute('aria-busy') }`)
js = js.replace(/  const note=document\.createElement\('p'\);note\.className='preview-footer-note';[^\n]+\n  document\.querySelector\([^\n]+\n/, '')
if (/로컬 시연|로컬 미리보기|preview-policy-note/.test(js)) throw new Error('Demo behavior remains')
await fs.writeFile(path.join(output, 'index.html'), html)
await fs.writeFile(path.join(output, 'preview.js'), js)
await fs.writeFile(path.join(output, 'preview.css'), (await fs.readFile(path.join(source, 'preview.css'), 'utf8')) + '\n.preview-privacy {background:#fff;border-radius:14px} .public-privacy {box-sizing:border-box;padding:24px;color:#222;background:#fff;border-radius:14px} .public-privacy h2{font-size:22px;margin-bottom:20px;padding-right:28px} .public-privacy pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.8 sans-serif} .public-honeypot{position:absolute!important;left:-10000px!important;width:1px!important;height:1px!important} button:disabled{cursor:wait;opacity:.7}\n')
console.log(JSON.stringify({ output, mode: 'public-inquiry-form', policyVersion: '2026-10-07-v1' }))
