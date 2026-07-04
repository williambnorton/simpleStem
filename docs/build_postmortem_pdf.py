#!/usr/bin/env python3
"""Build docs/postmortem_hangs.pdf — the audio-wedge postmortem with diagrams.

Regenerate after editing:  python3 docs/build_postmortem_pdf.py
Source content mirrors docs/10_AUDIO_WEDGE_DEEP_DIVE.md (researched 2026-07-04).
"""
import os
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table,
                                TableStyle, PageBreak, Flowable)

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'postmortem_hangs.pdf')

RED = colors.HexColor('#c0392b')
GREEN = colors.HexColor('#2c8f57')
AMBER = colors.HexColor('#b3541e')
GREY = colors.HexColor('#666666')
LIGHT = colors.HexColor('#e5e2da')

styles = getSampleStyleSheet()
H1 = ParagraphStyle('H1x', parent=styles['Title'], fontSize=20, spaceAfter=6)
H2 = ParagraphStyle('H2x', parent=styles['Heading2'], fontSize=13, spaceBefore=14, spaceAfter=6)
BODY = ParagraphStyle('Bodyx', parent=styles['Normal'], fontSize=9.5, leading=13)
SMALL = ParagraphStyle('Smallx', parent=styles['Normal'], fontSize=8, leading=11, textColor=GREY)
CELL = ParagraphStyle('Cellx', parent=styles['Normal'], fontSize=8.5, leading=11)
CELLB = ParagraphStyle('CellBx', parent=CELL, fontName='Helvetica-Bold')


class FailureChain(Flowable):
    """The failure-chain diagram: XR18 -> coreaudiod -> Chrome -> stall."""
    def __init__(self, width=7.0 * inch):
        super().__init__()
        self.width = width
        self.height = 2.55 * inch

    def draw(self):
        c = self.canv
        w = self.width

        def box(x, y, bw, bh, title, sub1, sub2, stroke, fill=None):
            c.saveState()
            if fill:
                c.setFillColor(fill)
                c.roundRect(x, y, bw, bh, 6, stroke=0, fill=1)
            c.setStrokeColor(stroke)
            c.setLineWidth(1.4)
            c.roundRect(x, y, bw, bh, 6, stroke=1, fill=0)
            c.setFillColor(colors.black)
            c.setFont('Helvetica-Bold', 8.5)
            c.drawCentredString(x + bw / 2, y + bh - 15, title)
            c.setFillColor(GREY)
            c.setFont('Helvetica', 7.5)
            c.drawCentredString(x + bw / 2, y + bh - 27, sub1)
            c.drawCentredString(x + bw / 2, y + bh - 38, sub2)
            c.restoreState()

        def arrow(x1, y, x2, color):
            c.saveState()
            c.setStrokeColor(color)
            c.setFillColor(color)
            c.setLineWidth(1.6)
            c.line(x1, y, x2 - 6, y)
            c.setLineWidth(0)
            p = c.beginPath()
            p.moveTo(x2, y); p.lineTo(x2 - 7, y + 3.5); p.lineTo(x2 - 7, y - 3.5); p.close()
            c.drawPath(p, stroke=0, fill=1)
            c.restoreState()

        top = self.height - 58
        bw, bh, gap = 100, 50, 26
        x = 0
        box(x, top, bw, bh, 'XR18 USB endpoint', 'XMOS XS1 + USB3340', 'USB 2.0 · 18x18 ch', colors.HexColor('#8a8577'))
        arrow(x + bw, top + bh / 2, x + bw + gap, RED)
        c.setFillColor(RED); c.setFont('Helvetica', 7)
        c.drawCentredString(x + bw + gap / 2, top + bh / 2 + 8, 'glitch')
        c.setFillColor(GREY)
        c.drawCentredString(x + bw + gap / 2, top - 12, 'cable · dongle · sleep/wake')

        x += bw + gap
        box(x, top, bw, bh, 'coreaudiod wedges', 'HAL calls block forever', 'known macOS failure class', RED, colors.HexColor('#faeceb'))
        arrow(x + bw, top + bh / 2, x + bw + gap, RED)

        x += bw + gap
        box(x, top, bw, bh, 'Chrome audio service', 'separate sandboxed process', 'device authorization hangs', RED, colors.HexColor('#faeceb'))
        arrow(x + bw, top + bh / 2, x + bw + gap, RED)

        x += bw + gap
        box(x, top, bw + 26, bh, 'Every media element stalls', 'readyState 0, even a WAV blob', '"no stems responded"', RED, colors.HexColor('#f6dedb'))

        # Healthy parallel path
        gx = 2 * (bw + gap)
        box(gx, top - 78, bw, 36, 'HTTP fetch still perfect', 'network is a different process', '', GREEN, colors.HexColor('#eaf5ee'))
        c.saveState()
        c.setStrokeColor(GREEN); c.setLineWidth(1.2); c.setDash(3, 3)
        c.line(gx + bw / 2, top - 42, gx + bw / 2, top - 2)
        c.restoreState()

        # Timing bar
        ty = 18
        c.saveState()
        c.setFont('Helvetica', 7.5); c.setFillColor(GREY)
        c.drawString(0, ty + 8, 'Timing, from pressing Play:')
        c.setStrokeColor(colors.HexColor('#bbbbbb')); c.setLineWidth(1.6)
        c.line(120, ty, w - 6, ty)
        marks = [(160, RED, '3s — app watchdog gives up', True),
                 (290, GREY, '10s — Chrome falls back to a SILENT null sink', False),
                 (430, GREY, '~3min — Chrome kills its audio service', True)]
        for mx, col, label, below in marks:
            c.setFillColor(col)
            c.circle(mx, ty, 3, stroke=0, fill=1)
            c.setFont('Helvetica-Bold' if col is RED else 'Helvetica', 7)
            c.drawCentredString(mx + 30, ty - 13 if below else ty + 8, label)
        c.restoreState()


def t(data, widths, header=True):
    tbl = Table(data, colWidths=widths, repeatRows=1 if header else 0)
    style = [
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LINEBELOW', (0, 0), (-1, 0), 1.2, colors.HexColor('#999999')),
        ('LINEBELOW', (0, 1), (-1, -2), 0.5, LIGHT),
        ('LEFTPADDING', (0, 0), (-1, -1), 4),
        ('RIGHTPADDING', (0, 0), (-1, -1), 4),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
    ]
    tbl.setStyle(TableStyle(style))
    return tbl


story = []
story.append(Paragraph('Postmortem: The Audio Wedges', H1))
story.append(Paragraph('simpleStem Performer rig · researched and written 2026-07-04 · '
                       'three wedges July 2–4 · full citations in docs/10_AUDIO_WEDGE_DEEP_DIVE.md', SMALL))
story.append(Spacer(1, 10))

story.append(Paragraph('What happened', H2))
story.append(Paragraph(
    'Three times in two days, every song in the portal failed with '
    '<b>&ldquo;no stems responded after 3s&rdquo;</b> while the server, network, and files were provably '
    'healthy (HTTP fetches of the same stems streamed at full speed; even an in-memory WAV blob '
    'would not load). Once, <font face="Courier">sudo killall coreaudiod</font> fixed it in 4&nbsp;ms. '
    'Once, only physically replugging the XR18&rsquo;s USB cable fixed it. Once, a coreaudiod kick left '
    'the XR18 re-enumerated as a 2-channel device (&ldquo;orphaned&rdquo;) before it recovered to 18 channels on its own.', BODY))
story.append(Spacer(1, 8))

story.append(Paragraph('The failure chain', H2))
story.append(FailureChain())
story.append(Spacer(1, 4))
story.append(Paragraph(
    'Chrome runs all CoreAudio calls in a separate sandboxed <b>audio service process</b> — which is why '
    'networking stays perfect while audio dies. New media elements wait on <b>device authorization</b> from '
    'that service; when coreaudiod is hung the wait runs to Chrome&rsquo;s 10-second timeout, after which playback '
    'proceeds <b>silently</b> into a null sink. simpleStem&rsquo;s watchdog fires at 3 seconds — inside that window — '
    'so a wedged audio device always presents as &ldquo;no stems responded.&rdquo;', BODY))

story.append(Paragraph('Two diseases, one symptom', H2))
story.append(t([
    [Paragraph('<b>Incident</b>', CELLB), Paragraph('<b>Wedge side</b>', CELLB), Paragraph('<b>What fixed it</b>', CELLB), Paragraph('<b>Why</b>', CELLB)],
    [Paragraph('Jul 3, evening', CELL), Paragraph('Daemon-side (macOS)', CELL), Paragraph('killall coreaudiod — audio back in 4 ms', CELL),
     Paragraph('Classic coreaudiod wedge; documented macOS failure class, heaviest on Apple Silicon, sleep/wake the top trigger', CELL)],
    [Paragraph('Jul 4, morning', CELL), Paragraph('Board-side (XR18)', CELL), Paragraph('USB unplug/replug only; killall did NOT stick', CELL),
     Paragraph('The board&rsquo;s XMOS USB controller hung; a fresh daemon kept re-opening a dead endpoint. Only a physical reset clears it', CELL)],
    [Paragraph('2-ch &ldquo;orphaned&rdquo; state', CELL), Paragraph('Re-enumeration', CELL), Paragraph('Recovered on its own / replug', CELL),
     Paragraph('Matches Mac reports that the X&nbsp;AIR 2-in/2-out USB mode is broken — re-enumeration can land there', CELL)],
], [0.95 * inch, 1.15 * inch, 1.9 * inch, 3.0 * inch]))

story.append(Paragraph('The recovery ladder — what each rung resets', H2))
story.append(t([
    [Paragraph('<b>Step</b>', CELLB), Paragraph('<b>Resets</b>', CELLB), Paragraph('<b>Right when</b>', CELLB), Paragraph('<b>Gotcha</b>', CELLB)],
    [Paragraph('1 · Replug XR18 USB (5 s out)', CELL), Paragraph('The board&rsquo;s XMOS USB controller', CELL),
     Paragraph('Board-side hang — killall didn&rsquo;t stick', CELL), Paragraph('Needs hands at the board', CELL)],
    [Paragraph('2 · sudo killall coreaudiod', CELL), Paragraph('The macOS audio daemon', CELL),
     Paragraph('Daemon-side wedge', CELL), Paragraph('May re-enumerate XR18 as 2-ch; launchctl kickstart is blocked since macOS 14.4 — use killall', CELL)],
    [Paragraph('3 · Reload the portal tab', CELL), Paragraph('Chrome&rsquo;s client audio state', CELL),
     Paragraph('Always, after rungs 1–2', CELL), Paragraph('Clients hold corrupted state across a daemon bounce (documented)', CELL)],
    [Paragraph('4 · Power-cycle the XR18 (10 s)', CELL), Paragraph('Everything board-side', CELL),
     Paragraph('Replug didn&rsquo;t do it', CELL), Paragraph('Re-pick the device in macOS Sound', CELL)],
], [1.55 * inch, 1.5 * inch, 1.6 * inch, 2.35 * inch]))

story.append(PageBreak())

story.append(Paragraph('Prevention, ranked by evidence strength', H2))
story.append(t([
    [Paragraph('<b>Fix</b>', CELLB), Paragraph('<b>Evidence</b>', CELLB), Paragraph('<b>Notes</b>', CELLB)],
    [Paragraph('One quality USB-C&rarr;USB-B cable, &le;2 m, straight into the Mac — no dongle, no passive hub', CELL),
     Paragraph('<font color="#2c8f57"><b>STRONG</b></font> — multiple confirmed community fixes', CELL),
     Paragraph('Our 15-foot (4.6 m) cable is towards the practical limit for USB 2.0 audio and the prime suspect for recurring endpoint glitches. Shorter cable ordered 2026-07-04.', CELL)],
    [Paragraph('XR18 firmware current (USB fixes shipped in 1.23)', CELL),
     Paragraph('<font color="#2c8f57"><b>VENDOR</b></font> — Behringer changelog', CELL),
     Paragraph('Rig updated to 1.25 on 2026-07-04. Changelog for 1.23: &ldquo;Fixed: USB audio issues (mostly at 44K1)&rdquo;.', CELL)],
    [Paragraph('USB mode 18-in/18-out, 48 kHz pinned everywhere', CELL),
     Paragraph('<font color="#2c8f57"><b>GOOD</b></font>', CELL),
     Paragraph('The 2-in/2-out mode is reported broken on Mac; 44.1 kHz is where the firmware bugs lived. simpleStem is all-48k by policy.', CELL)],
    [Paragraph('No sleep at gigs: AC power, lid open, caffeinate', CELL),
     Paragraph('<font color="#b3541e"><b>MODERATE</b></font>', CELL),
     Paragraph('Sleep/wake is the most-cited coreaudiod trigger. performer.sh now runs caffeinate -dis automatically for the life of the rig (2026-07-04). The hot-corner screensaver still works — caffeinate blocks sleep, not a manually invoked saver.', CELL)],
    [Paragraph('Wi-Fi radio OFF at the venue', CELL),
     Paragraph('<font color="#b3541e"><b>MODERATE</b></font>', CELL),
     Paragraph('Removes mDNS churn, Drive-sync retries, captive-portal probing; forces link-local addressing. XR18 control rides Ethernet, the portal is localhost, stems are in local cache — nothing on stage needs the radio. New WIFI pill in the portal header toggles it (2026-07-04).', CELL)],
    [Paragraph('If a hub is unavoidable: externally powered Thunderbolt dock', CELL),
     Paragraph('<font color="#b3541e"><b>MODERATE</b></font>', CELL),
     Paragraph('The only hub class that resolved the MacBook USB-2 disconnect wave.', CELL)],
    [Paragraph('Smart hub + uhubctl for scripted port power-cycling', CELL),
     Paragraph('<font color="#888888"><b>NICHE</b></font>', CELL),
     Paragraph('The only software substitute for a physical replug on macOS.', CELL)],
], [2.5 * inch, 1.35 * inch, 3.15 * inch]))

story.append(Paragraph('Assessment of the standing hypotheses', H2))
story.append(Paragraph(
    '<b>&ldquo;Known issue with Mac Core Audio&rdquo; — CONFIRMED.</b> coreaudiod wedging with USB interfaces is a '
    'recurring, vendor-acknowledged macOS failure class (Apple Dev Forums threads through Sonoma and Sequoia; '
    'Apple shipped USB/audio fixes in 14.4.1; Focusrite and Rogue Amoeba both document it). '
    '<b>&ldquo;The XR18 gives up and shuts down the channel&rdquo; — PARTLY.</b> Nothing suggests the firmware shuts '
    'the port down deliberately; the evidence points at the USB link glitching and the board&rsquo;s XMOS controller '
    'then hanging in a state only a physical reset clears. The distinction matters: the cure is a better link '
    '(short cable, no dongle, current firmware), not different board settings.', BODY))
story.append(Spacer(1, 6))
story.append(Paragraph(
    'Follow-up implemented in the app: mode-aware transport pills, single-lane visualizer, Wi-Fi pill, automatic '
    'caffeinate. Candidate next step: when the stem watchdog fires, auto-run the WAV-blob probe and show '
    '&ldquo;AUDIO DEVICE WEDGED — first-aid ladder&rdquo; instead of &ldquo;pick another song.&rdquo;', BODY))
story.append(Spacer(1, 10))
story.append(Paragraph(
    'Sources: Apple Dev Forums 742465 / 748228 · Apple Communities 255788454, 255046431 · Apple 14.4.1 release notes · '
    'Focusrite KBs · Behringer X18/XR18 firmware changelog · behringer.world · Cockos & Steinberg forums · vogelchr XR18 teardown · '
    'Chromium source (audio_device_factory, audio_renderer_impl, audio_thread_hang_monitor, services/audio) · '
    'crbug 160920 / 615589 / 422522 · webrtc 4799 · Hancke (2017) · uhubctl. Full annotated list: docs/10_AUDIO_WEDGE_DEEP_DIVE.md.', SMALL))

doc = SimpleDocTemplate(OUT, pagesize=letter,
                        leftMargin=0.7 * inch, rightMargin=0.7 * inch,
                        topMargin=0.7 * inch, bottomMargin=0.7 * inch,
                        title='Postmortem: The Audio Wedges',
                        author='simpleStem')
doc.build(story)
print('wrote', OUT)
