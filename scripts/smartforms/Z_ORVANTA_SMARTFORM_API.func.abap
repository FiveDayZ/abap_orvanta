FUNCTION z_orvanta_smartform_api.
*" Remote-enabled function module, all parameters pass by value.
*" IMPORTING IV_ACTION IV_FORMNAME IV_LANGUAGE IV_VERSION IV_XML
*"   IV_EXPECTED IV_PACKAGE IV_TRANSPORT: TYPE STRING
*" EXPORTING EV_PROTOCOL EV_STATUS EV_CODE EV_MESSAGE EV_FORMNAME
*"   EV_LANGUAGE EV_VERSION EV_XML EV_FINGERPRINT EV_PACKAGE
*"   EV_ACTIVE EV_INACTIVE EV_REQUEST: TYPE STRING
  CALL METHOD zcl_orvanta_smartform=>execute
    EXPORTING iv_action = iv_action iv_formname = iv_formname
      iv_language = iv_language iv_version = iv_version
      iv_xml = iv_xml iv_expected = iv_expected
      iv_package = iv_package iv_transport = iv_transport
    IMPORTING ev_protocol = ev_protocol ev_status = ev_status
      ev_code = ev_code ev_message = ev_message
      ev_formname = ev_formname ev_language = ev_language
      ev_version = ev_version ev_xml = ev_xml
      ev_fingerprint = ev_fingerprint ev_package = ev_package
      ev_active = ev_active ev_inactive = ev_inactive
      ev_request = ev_request.
ENDFUNCTION.
