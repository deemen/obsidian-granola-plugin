---
granola_id: {{granola_id}}
granola_url: {{granola_url}}
title: "{{granola_title}}"
date: {{granola_date}}
type: meeting
{{#granola_meeting_transcript}}
meeting_transcript: "[[{{granola_meeting_transcript}}]]"
{{/granola_meeting_transcript}}
attendees:
{{granola_attendees_linked_list}}
tags:
  - meeting
  - granola
---
{{#granola_private_notes}}## Notes

{{granola_private_notes}}
{{/granola_private_notes}}
{{#granola_enhanced_notes}}## Summary

{{granola_enhanced_notes}}
{{/granola_enhanced_notes}}
